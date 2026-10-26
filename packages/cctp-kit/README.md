# @mysten-incubation/cctp-kit

Embeddable USDC bridge for Sui dapps, built on Circle CCTP v2. Framework-agnostic core (Lit +
nanostores) with React bindings under `@mysten-incubation/cctp-kit/react`. Pairs with
[dapp-kit 2.0](https://sdk.mystenlabs.com/dapp-kit) for the Sui side.

## Installation

```sh
npm i @mysten-incubation/cctp-kit @mysten/dapp-kit-core @mysten/sui @wagmi/core   # React apps: @mysten/dapp-kit-react instead of -core
# the ready-made EVM + Solana wallet layer (skip it if you pass your own adapters):
npm i @reown/appkit @reown/appkit-adapter-wagmi @reown/appkit-adapter-solana
```

## Usage (vanilla / any framework)

```ts
import { createDAppKit } from '@mysten/dapp-kit-core';
import { createCctpKit } from '@mysten-incubation/cctp-kit';
import { appKitWallets } from '@mysten-incubation/cctp-kit/appkit';
import '@mysten-incubation/cctp-kit/web'; // registers <mysten-cctp-bridge>

const kit = createCctpKit({
	dAppKit,
	direction: 'both',
	wallets: { layer: appKitWallets({ projectId }) },
});

const el = document.querySelector('mysten-cctp-bridge')!;
el.instance = kit;
```

### React

```tsx
import {
	createCctpKit,
	CctpKitProvider,
	useActiveCctpTransfer,
} from '@mysten-incubation/cctp-kit/react';
import { appKitWallets } from '@mysten-incubation/cctp-kit/appkit';
import { CctpBridge } from '@mysten-incubation/cctp-kit/react/ui';

const kit = createCctpKit({ dAppKit, wallets: { layer: appKitWallets({ projectId }) } });

export function App() {
	return (
		<CctpKitProvider kit={kit}>
			<CctpBridge />
		</CctpKitProvider>
	);
}
```

Every hook accepts an optional `{ kit }` to bypass context, mirroring dapp-kit's hooks. Import
`<CctpBridge />` from the `/react/ui` entry so the `/react` entry stays SSR-safe.

### Configuration

| Option                   | Description                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dAppKit`                | The host's dapp-kit 2.0 instance (required).                                                                                                                            |
| `network`                | `'mainnet'` or `'testnet'`; inferred from dapp-kit's current network.                                                                                                   |
| `direction`              | `'both'`, `'inflow'` (all routes end on Sui) or `'outflow'`.                                                                                                            |
| `chains`                 | `{ allow, deny, from: { allow, deny }, to: { allow, deny } }` by chain key.                                                                                             |
| `transferSpeed`          | `{ default, allow }` with `'fast'` and/or `'standard'`.                                                                                                                 |
| `rpc`                    | `{ urls: { base: ['https://a', 'https://b'] }, mode }`, where `mode` is `'prepend'` or `'replace'`.                                                                     |
| `icons`                  | Override chain icons by key (URL / data URI), or `null` for a text monogram. Defaults load from `icons.llamao.fi`; allow it in `img-src` or override.                   |
| `wallets.evm`            | Inject an EVM adapter, e.g. `createEvmWalletFromWagmiConfig(config)`.                                                                                                   |
| `wallets.solana`         | Inject a Solana adapter.                                                                                                                                                |
| `wallets.layer`          | Supplies the EVM and Solana wallets you do not inject. `appKitWallets({ projectId, metadata, themeMode })` from `/appkit` is the ready-made one, built on Reown AppKit. |
| `sui.executeTransaction` | Signs and executes the kit's Sui burns and claims in place of dapp-kit's wallet. See [Executing Sui transactions yourself](#executing-sui-transactions-yourself).       |
| `claim`                  | `'auto'` (default) claims as soon as Circle attests; `'manual'` stops at `readyToMint` until `kit.claim(id)`.                                                           |
| `storage` / `storageKey` | Where in-flight transfers are persisted (`localStorage` by default).                                                                                                    |
| `onEvent`                | Transfer and wallet lifecycle events.                                                                                                                                   |

### Theming

The widget reads the same shadcn-style custom properties as dapp-kit (`--background`,
`--foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--border`, `--accent`,
`--muted`, `--muted-foreground`, `--popover`, `--destructive`, `--positive`, `--ring`, `--input`,
`--radius`, `--font-sans`). Set them on `:root` or on `mysten-cctp-bridge`; a host that has themed
dapp-kit gets the widget themed for free. Three optional extras cover button typography for brands
with a distinct button face: `--font-button`, `--button-text-transform` and
`--button-letter-spacing`. See `examples/react/src/themes.ts` for complete presets (light, dark, a
deposit-only plugin, DeepBook, Sui, sunset).

### Form behaviour

Sui is always on one side of the form and is fixed to the network of the host's dapp-kit instance
(the host decides mainnet vs testnet; the widget never shows a Sui network picker). The other side
is a chain dropdown limited to the configured routes. In `both` mode the round button between the
panels swaps which side Sui is on.

### Tracking transfers started elsewhere

`kit.importTransfer({ txHash, sourceChain? })` looks up a burn by its source transaction hash
(Circle's attestation API first, then the chain itself for EVM burns Circle has not decoded yet),
persists it and drives it up to **Claim**. Sui digests and Solana signatures are recognised by
shape; EVM hashes need `sourceChain`. The widget exposes this as "Track a transfer by transaction
hash" under the pending list, so a dismissed card or a transfer made on another device can be
recovered.

### Time estimates

The in-flight card's "Waiting" clock counts from the burn's confirmation time on the source chain
(`burnedAt`, read from the block / checkpoint, also for transfers tracked by hash and backfilled for
older records). The quote's "attestation wait" comes from Circle's published finality table per
source chain (`FINALITY_BY_CHAIN`): seconds on fast-finality chains, 15 to 19 minutes on Ethereum
and most L2s, and up to 32 hours on Linea for standard transfers. Fast transfers wait a few
confirmations instead. The destination mint is a separate transaction the user signs.

### Persistence and resume

Every transfer is a record in `storage` (browser `localStorage` by default, keyed per network; pass
`storage: null` to disable) and is updated after each step, including the source transaction hash
the moment the wallet returns it. On creation the kit resumes any record that was interrupted: it
keeps polling for the attestation and stops at **Claim**, because the destination mint needs the
user's wallet. The card shows a Resume button for anything nothing is driving. A transfer started
elsewhere can be brought in with "Track a transfer by transaction hash".

What the widget lists follows the connected wallets:

- A transfer that is still in progress is always listed, whichever wallet is connected. Its record
  is the only way back to a burn that is waiting to be claimed, and anyone may submit the claim: the
  USDC goes to the recorded recipient either way.
- A completed transfer is listed only while a connected wallet (Sui, EVM or Solana) is its sender or
  its recipient. Records are never deleted; they reappear when that wallet connects again.
- A transfer looked up by hash stays listed until the page reloads.

`stores.$history` is that list; `stores.$transfers` is everything in storage.

### Executing Sui transactions yourself

`sui.executeTransaction` replaces dapp-kit's `signAndExecuteTransaction` for the kit's Sui burns and
claims, e.g. to use the app's own fullnode and gas budget, or another signer for claims.

```ts
const kit = createCctpKit({
	dAppKit,
	claim: 'manual',
	sui: {
		executeTransaction: async ({ kind, transaction }) => {
			if (kind === 'claim') transaction.setSender(relayerAddress);
			return { digest: (await myExecutor(transaction)).digest };
		},
	},
});
```

- A burn spends the connected wallet's USDC. Anyone may submit a claim whose destination caller is
  zero and the USDC still goes to the recorded recipient, so with an executor a claim needs no
  connected wallet.
- Resolve with the digest once the transaction has executed, and throw if it failed.

`claim: 'manual'` stops transfers at `readyToMint` until `kit.claim(id)`, which rejects a transfer
Circle has not attested and never burns.

### Adding the CCTP calls to your own transactions

`suiDepositForBurn` and `suiReceiveMessage` return transaction thunks for `tx.add()`.
`suiDepositForBurn` burns the coin it is given, which can come from an earlier call in the same
transaction:

```ts
import { mintRecipientBytes, SUI_MAINNET, suiDepositForBurn } from '@mysten-incubation/cctp-kit';

const tx = new Transaction();
const coin = tx.add(withdrawUsdcFromMyAccount(amount));
tx.add(
	suiDepositForBurn(SUI_MAINNET, {
		coin,
		destinationDomain: base.domain,
		mintRecipient: mintRecipientBytes(recipient, base),
		maxFee: 0n,
		minFinalityThreshold: 2000,
	}),
);
```

The whole coin is burned, so it must hold exactly the amount to send. Track the burn with
`kit.importTransfer({ txHash })`. Calls after a claim cannot use the minted USDC: Circle's handler
sends it straight to the recipient.

### Content Security Policy

Hosts with a strict CSP need to allow:

- `connect-src`: `https://iris-api.circle.com` (mainnet) or `https://iris-api-sandbox.circle.com`
  (testnet); every RPC host you keep in `rpc` or the built-in defaults (see the chain registry); the
  Sui endpoint your dapp-kit client uses. The default wallet layer (Reown AppKit) also talks to
  Reown's own hosts, typically `api.web3modal.org`, `pulse.walletconnect.org`,
  `relay.walletconnect.com` (wss) and `fonts.reown.com`; check Reown's current documentation for the
  full list.
- Solana needs no `wss://` entry: the kit polls for confirmations over HTTPS.
- `img-src`: `https://icons.llamao.fi` for the default chain icons, or override `icons`.

### Other web component libraries on the page

Like dapp-kit 2.0, the widget's components use scoped custom element registries and import the
`@webcomponents/scoped-custom-element-registry` polyfill for browsers without them. Installing that
polyfill replaces the page's custom element registry, and elements defined before that moment stop
upgrading (their classes throw "Illegal constructor"). If the host also uses a library that defines
custom elements at startup, such as Reown AppKit's own modal, load the polyfill before any of it:
put `import '@webcomponents/scoped-custom-element-registry'` at the very top of the client entry, or
prepend it to the bundler's entry. Importing it "first" inside a component is not enough when routes
are split into separate chunks.

### Solana notes

- The mint recipient on Solana is the wallet's USDC associated token account. The widget derives it
  from the recipient wallet and, when claiming, creates the account if it is missing (the claimer
  pays the rent), for the claimer's own wallet or for a third-party recipient whose wallet the
  record knows.
- Tracked transfers resolve the recipient wallet from the token account on-chain; if the account
  does not exist yet, the recipient wallet has to create it before the claim.
- The claim is a v0 transaction compiled against Circle's address lookup table for CCTP, which keeps
  it under Solana's 1232-byte limit once the wallet adds its priority fee. The burn and the token
  account transaction are legacy, so an adapter passed as `wallets.solana` has to sign and send both
  kinds.
- Solana RPC calls fall over to the next endpoint in `rpc` on transport errors. A balance that
  cannot be read shows as unknown rather than zero and does not block the form.

### Sui notes

- Circle does not run a relayer for Sui, so the destination mint is submitted by the user's wallet,
  or by whatever signs for `sui.executeTransaction`. The widget persists the attested message and
  shows a **Claim** button if the tab was closed in between.
- Sui is a standard-speed source: Circle lists Fast Transfer as not applicable there because a
  standard attestation already lands in seconds. Fast into Sui is offered when the source chain
  supports it.
