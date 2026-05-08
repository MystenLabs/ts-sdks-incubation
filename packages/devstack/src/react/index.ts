// React adapter public barrel. Apps import from
// `@mysten-incubation/devstack/react`. Peer deps (`react`,
// `@mysten/dapp-kit-react`) are optional — the rest of devstack stays
// usable without them.
//
// Surface is intentionally minimal: a single `createDevstackDappKit`
// factory covers the dapp-kit + wallet adapter + panels wiring;
// `localnetWalrusOptions` returns the localnet-specific config inputs
// for `new WalrusClient(...)`. Apps read `manifest` directly from the
// codegen-emitted `src/generated/manifest.ts` — no devstack-specific
// React context needed.
//
// The browser-side `createDevstackDappKit({ manifest })` here pairs
// with the server-side `walletApp({ port })` plugin in the main
// package — the import subpath disambiguates the role.

export {
	createDevstackDappKit,
	localnetDappKitConfig,
	localnetMvrOverrides,
	type CreateDevstackDappKitOptions,
	type DevstackDappKit,
	type LocalnetDappKitConfig,
	type LocalnetDappKitConfigOptions,
	type LocalnetMvrOverrides,
} from './create-devstack-dapp-kit.js';
export {
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusOptionsInit,
} from './walrus.js';
