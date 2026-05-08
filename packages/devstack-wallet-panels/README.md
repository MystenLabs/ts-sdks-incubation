# @mysten-incubation/devstack-wallet-panels

Drop-in Lit panels — Faucet, Packages, Network — for the
[`@mysten-incubation/dev-wallet`](../dev-wallet) panel API. Pairs with the
[`walletApp()`](../devstack/src/plugins/wallet-app/index.ts) plugin from
`@mysten-incubation/devstack` so a browser app can mint test coins, inspect deployed package IDs,
and see the live RPC/faucet/wallet-app URLs without ever loading a private key into its bundle.

## Install

```sh
pnpm add @mysten-incubation/devstack-wallet-panels @mysten-incubation/dev-wallet
```

`@mysten-incubation/devstack` is a peer dependency — the panels read from the typed manifest emitted
by `devstack up`.

## Use

The one-liner: `createDevstackDappKit({ manifest })` from
`@mysten-incubation/devstack/react` already wires these panels in.

```ts
// dapp-kit.ts
import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';

export const { dAppKit } = createDevstackDappKit({ manifest });
```

`configureDevstackPanels(manifest)` stashes the manifest for the panel custom elements to read on
render. `devstackPanels()` returns a `WalletPanelDescriptor[]` that drops straight into
`devWalletInitializer({ panels })`.

### Explicit composition

If you're dropping into raw `createDAppKit` instead — to add custom adapters, override the network
list, or interleave with other wallet initializers — wire the panels by hand:

```ts
// dapp-kit.ts
import { createDAppKit } from '@mysten/dapp-kit-core';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';
import { manifest } from 'virtual:devstack-manifest';

configureDevstackPanels(manifest);

const adapter = createDevstackAdapterFromManifest(manifest);

export const dAppKit = createDAppKit({
	...localnetDappKitConfig(manifest),
	walletInitializers: [
		devWalletInitializer({
			adapters: adapter ? [adapter] : [],
			panels: devstackPanels(),
			autoConnect: true,
			autoApprove: true,
			mountUI: true,
		}),
	],
});
```

## What you get

Three tabs appended to dev-wallet's built-in Assets / Objects / Settings:

- **Faucet** — drips SUI via the localnet faucet (parses `coins_sent` and surfaces rate-limit /
  already-funded responses), and mints `1 unit` of any registered token by calling
  `<pkg>::<module>::mint(treasuryCap, amount, recipient)` as the publisher account. Pulls
  `treasuryCapId` from `manifest.registry.tokens[*].treasuryCapId` first, falling back to the
  matching package's `captured.treasuryCapId` so plugins that don't forward the field still work.
- **Packages** — every entry under `manifest.registry.packages` with a click-to-copy package id.
  Inline section per package shows its `captured` object ids (`treasuryCapId`, `metadataId`,
  `upgradeCapId`, …). Custom token entries from `manifest.registry.tokens` render below.
- **Network** — current app, network, last-emitted timestamp, every entry under
  `manifest.registry.services` (RPC, faucet, **wallet-app**, …), and the seeded accounts list.

## Authoring custom panels

`devstack-wallet-panels` is one consumer of dev-wallet's panel API. Build your own:

```ts
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('my-panel')
export class MyPanel extends LitElement {
	override render() {
		return html`<div>my panel</div>`;
	}
}

devWalletInitializer({
	// ...
	panels: [...devstackPanels(), { id: 'mine', label: 'Mine', tagName: 'my-panel' }],
});
```

The wallet mounts the registered tag with `.wallet`, `.activeAddress`, and `.client` properties
wired in. See the source of `devstack-faucet-panel` for a worked example that builds + signs +
executes a transaction.

## License

[Apache-2.0](../../LICENSE)
