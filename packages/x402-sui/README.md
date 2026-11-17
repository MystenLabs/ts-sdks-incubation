# `@mysten-incubation/x402-sui`

> [!WARNING] **This is a temporary package.** It is a copy of the `@x402/sui` package proposed
> upstream in [x402-foundation/x402#3082](https://github.com/x402-foundation/x402/pull/3082), with
> the scheme spec from [#3081](https://github.com/x402-foundation/x402/pull/3081) included as
> [`SPEC.md`](./SPEC.md). It exists only until those PRs merge and `@x402/sui` is published. Then
> this package will be deprecated, and you should switch to `@x402/sui`. Don't build anything that
> depends on it long term.

Sui implementation of the x402 `exact` payment scheme. The facilitator accepts any transaction whose
effects credit `payTo` with exactly `amount`, so a payment may be funded from an address balance,
coins, swaps, or withdrawals.

Verification simulates the signed bytes with transaction checks enabled and gas selection disabled.
It rejects simulations that use mocked gas, including for sponsored payments. The gas owner's funds
must cover gas in addition to the transaction's withdrawals; a simulated recipient credit funded by
a mock gas coin is not a valid payment.

Supports `sui:mainnet`, `sui:testnet`, and `sui:devnet`.

## Installation

```bash
npm install @mysten-incubation/x402-sui
# or
pnpm add @mysten-incubation/x402-sui
```

## Usage

The package exports the `exact` scheme for all three x402 roles under
`@mysten-incubation/x402-sui/exact/{client,server,facilitator}`. Each is registered on the matching
core object: clients and resource servers can register the `sui:*` network family, and a facilitator
registers the concrete networks it serves.

### Client

```typescript
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { x402Client } from '@x402/core/client';
import { ExactSuiScheme } from '@mysten-incubation/x402-sui/exact/client';

// Any Sui signer works: Ed25519, Secp256k1, or a wallet-backed signer.
const keypair = Ed25519Keypair.generate();
const client = new x402Client().register('sui:*', new ExactSuiScheme(keypair));
```

On a 402 response the client builds a transaction that calls `balance::send_funds` for the required
amount to `payTo`, and signs it. The transaction carries a `ValidDuring` expiration covering the
current and next epoch. When the requirements advertise `extra.feePayer`, the sponsor is set as gas
owner with an empty gas payment, and the client refuses to sign if the gas budget exceeds the
advertised `extra.maxGasBudget`.

The client funds each payment with `tx.balance`, which draws on the address balance first and then
on coin objects. Coin selection, including the payer's own gas coin, is per transaction, so two
payments built at the same time from the same signer can pick the same coin objects, and at least
one of them fails to settle. Payments from one signer can only run concurrently when they use no
coin objects at all: paid from the address balance, with gas sponsored by the facilitator or a
gasless transfer. Otherwise, build and send them one at a time.

Sui USDC is a recognized default asset, so `x402Client` caps each USDC payment at $1 by default
(`DEFAULT_MAX_AMOUNT_PER_PAYMENT`). Change the cap, or allow other coin types such as SUI, with the
client's `spendControls` option.

### Server

```typescript
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactSuiScheme } from '@mysten-incubation/x402-sui/exact/server';

const server = new x402ResourceServer(
	new HTTPFacilitatorClient({ url: 'https://facilitator.example' }),
).register('sui:*', new ExactSuiScheme());

// Price resources in USDC ("$0.01") or with an explicit { amount, asset }.
```

### Facilitator

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactSuiScheme } from '@mysten-incubation/x402-sui/exact/facilitator';

// Register concrete networks: `/supported` lists them as registered, and resource
// servers match requirements against them exactly.
const facilitator = new x402Facilitator().register(
	['sui:mainnet', 'sui:testnet', 'sui:devnet'],
	new ExactSuiScheme({
		settlementGuard, // see Settlement deduplication
		clients: {
			'sui:mainnet': new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://my-node:443' }),
		},
	}),
);
```

No key is needed unless the facilitator sponsors gas. Options:

- `clients`: per-network Sui clients (gRPC or GraphQL). Networks without one use the public fullnode
  over gRPC.
- `feePayer`: a gas sponsor address, advertised as `extra.feePayer`.
- `executeTransaction`: submits facilitator-sponsored payments. Required when `feePayer` is set.
- `maxSponsoredGasBudget`: the gas budget cap for sponsored payments, in MIST, advertised as
  `extra.maxGasBudget`. Defaults to `10_000_000n` (0.01 SUI).
- `settlementGuard` (required): the settlement dedup store. See
  [Settlement deduplication](#settlement-deduplication).

The facilitator rejects a transaction without a `ValidDuring` or `Validity` expiration, or one that
is not valid in at most two consecutive epochs (`maxEpoch - minEpoch <= 1`). Settlement also
requires the current epoch to be inside that window.

When `asset` is SUI and `payTo` is the gas owner, the payment can't match: gas nets into the same
balance change, so `payTo` is never credited exactly `amount`.

#### Gas sponsorship

Set `feePayer` to the sponsor's address and supply an `executeTransaction` that adds the sponsor's
signature and submits. With the
[`@mysten-incubation/sponsor`](https://www.npmjs.com/package/@mysten-incubation/sponsor) SDK:

```typescript
import { createSponsor, defaults, gasBudget } from '@mysten-incubation/sponsor';
import type { SuiExecutor } from '@mysten-incubation/x402-sui';

const sponsor = createSponsor({
	signer: sponsorKeypair,
	client,
	validate: [defaults(), gasBudget({ max: 10_000_000n })],
});

const executeTransaction: SuiExecutor = ({ transaction, signatures }) =>
	sponsor.signAndExecuteTransaction({ transaction, userSignature: signatures });

new ExactSuiScheme({ settlementGuard, feePayer: sponsor.address, executeTransaction });
```

The sponsor address SHOULD be dedicated to paying gas, with no roles or privileges in other
contracts, since Move code can read it with `tx_context::sponsor()`.

> **Note:** passing `validate` replaces the sponsor's default validators. Keep `defaults()` in the
> list unless you mean to drop those checks.

The executor is used only for payments whose gas owner is `feePayer` and not the sender. Their
payload carries only the payer's signature; the executor adds the sponsor's. Other payments are
submitted directly. Before co-signing, the facilitator runs the sponsorship checks:

- The gas payment must be empty, so gas comes from the sponsor's address balance.
- The gas budget must not exceed `maxSponsoredGasBudget`.
- No command may use the gas coin.
- No input may withdraw funds from the sponsor, directly or through an allowance it funds.

A failed check returns `invalid_exact_sui_payload_sponsorship_rejected`, and a rejection from the
executor itself returns `sponsor_rejected`.

A sponsored transaction that fails because the payer's address balance can't cover the withdrawal
does not run and is not charged gas. One that aborts during execution costs up to its signed budget,
which the budget cap and the sponsor's rate limiting bound.

Per-sender rate limiting is left to the executor or sponsor.

#### Settlement deduplication

Re-submitting an executed Sui transaction returns its original result, so the facilitator claims
each transaction digest before submitting. A second settle of the same transaction fails with
`duplicate_settlement`. The claim is released if settlement fails, and kept for as long as the
`SettlementGuard` documentation requires if it succeeds.

If the outcome of a submission can't be established, settlement returns `settlement_pending` with
the digest in `transaction`, so the caller can reconcile on chain before retrying. Retrying the same
signed transaction is safe, since it executes at most once. Within the transaction's window, a retry
of a transaction that already executed reports its result. Outside the window, settle refuses it and
returns the digest so the caller can look it up.

A sponsored payment's simulated effects are checked before the sponsor co-signs it, so a payment
that simulates as not crediting `payTo` with exactly `amount` is rejected without spending the
sponsor's gas. Simulation can't guarantee what executes: a transaction can behave differently on
chain than in simulation. The gas cap and per-sender rate limiting still bound what the sponsor can
lose. If this facilitator verified the same payment against the same requirements within
`maxTimeoutSeconds` (capped at 10 minutes), settle reuses that result. Otherwise, for example in the
`upfront` flow, it simulates at settle.

`settlementGuard` is required. Claims must be shared by every process serving `/settle` and survive
restarts. Otherwise a payment that already settled can be settled again after a restart, or on
another process, and be reported as a second success. `SettlementCache` keeps claims in memory, so
it only suits development, tests, or a single process that accepts that risk:

```typescript
import { SettlementCache } from '@mysten-incubation/x402-sui';

new ExactSuiScheme({ settlementGuard: new SettlementCache() });
```

For production, use a shared, durable store. A claim held by a process that dies mid-settlement
blocks that digest until the store expires it. For example, with Redis:

```typescript
import type { SettlementGuard } from '@mysten-incubation/x402-sui';

// Covers the retention SettlementGuard requires; mainnet epochs last about
// 24 hours, so four days leaves room to spare.
const CLAIM_TTL_SECONDS = 4 * 24 * 60 * 60;

const settlementGuard: SettlementGuard = {
	async claim({ network, digest }) {
		const set = await redis.set(`x402:sui:${network}:${digest}`, '1', {
			NX: true,
			EX: CLAIM_TTL_SECONDS,
		});
		return set !== null;
	},
	async release({ network, digest }) {
		await redis.del(`x402:sui:${network}:${digest}`);
	},
};
```

## Testnet Resources

- **Test SUI**: https://faucet.sui.io/
- **Test USDC**: https://faucet.circle.com/

## License

Apache-2.0
