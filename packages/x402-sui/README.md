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
core object for the `sui:*` network family.

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
on coin objects. Coin selection is per transaction, so two payments built at the same time from the
same signer can pick the same coin objects, and at least one of them fails to settle. Concurrent
payments are only supported when the signer's address balance covers them. Otherwise, build and send
payments from one signer one at a time.

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
- `settlementGuard`: settlement deduplication. Defaults to an in-process guard.

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

new ExactSuiScheme({ feePayer: sponsor.address, executeTransaction });
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
`duplicate_settlement`. Before it submits a newly claimed payment, the facilitator also looks the
digest up, and reports a transaction that already executed as `duplicate_settlement`. The claim is
released if settlement fails. If it succeeds, the claim is kept for as long as the `SettlementGuard`
documentation requires.

If submission or the finality wait throws and the digest lookup finds nothing, the outcome is
unknown: the transaction may still execute. Settlement returns `settlement_pending` with the digest
in `transaction`, and marks the claim pending. The resource server's automatic retry of the same
signed transaction then reconciles it: it looks the digest up and reports what executed, even after
the transaction's window has ended. A transaction still not found is submitted again while its
window is open, and fails with `transaction_failed` once the window has passed.

A sponsored payment's simulated effects are checked before the sponsor co-signs it, so a payment
that would not credit `payTo` with exactly `amount` is rejected without spending the sponsor's gas.
If this facilitator verified the same payment against the same requirements within
`maxTimeoutSeconds` (capped at 10 minutes), settle reuses that result. Otherwise, for example in the
`upfront` flow, it simulates at settle.

A single facilitator process may keep its claims in memory, which is what the default in-process
guard does. If the process restarts and forgets its claims, the digest lookup is the only protection
against settling an executed payment again, and it depends on the node still having the transaction.
When several processes serve `/settle`, they must share one claim store with atomic claims. A
durable store is also worth it when `settle` can be called without `verify`, as in the `upfront`
flow. For example, with Redis:

```typescript
import type { SettlementClaim, SettlementGuard } from '@mysten-incubation/x402-sui';

// Covers the retention SettlementGuard requires; mainnet epochs last about
// 24 hours, so four days leaves room to spare.
const CLAIM_TTL_SECONDS = 4 * 24 * 60 * 60;

// Atomically: a held key stays held, and a free or pending key becomes held.
const CLAIM_SCRIPT = `
local state = redis.call('GET', KEYS[1])
if state == 'held' then return 'held' end
redis.call('SET', KEYS[1], 'held', 'EX', ARGV[1])
if state == 'pending' then return 'pending' end
return 'claimed'`;

const claimKey = ({ network, digest }: { network: string; digest: string }) =>
	`x402:sui:${network}:${digest}`;

const settlementGuard: SettlementGuard = {
	async claim(key) {
		return (await redis.eval(CLAIM_SCRIPT, {
			keys: [claimKey(key)],
			arguments: [String(CLAIM_TTL_SECONDS)],
		})) as SettlementClaim;
	},
	async markPending(key) {
		await redis.set(claimKey(key), 'pending', { XX: true, KEEPTTL: true });
	},
	async release(key) {
		await redis.del(claimKey(key));
	},
};
```

## Testnet Resources

- **Test SUI**: https://faucet.sui.io/
- **Test USDC**: https://faucet.circle.com/

## License

Apache-2.0
