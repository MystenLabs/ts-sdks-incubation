// React adapter public barrel. Apps import from
// `@mysten-incubation/devstack/react`. Peer deps (`react`,
// `@mysten/dapp-kit-react`) are optional — the rest of devstack stays
// usable without them.
//
// Surface is intentionally minimal: a single `createWalletApp` factory
// covers the dapp-kit + wallet adapter + panels wiring; `localnetWalrusOptions`
// returns the localnet-specific config inputs for `new WalrusClient(...)`.
// Apps read `manifest` directly from the codegen-emitted
// `src/generated/manifest.ts` — no devstack-specific React context needed.

export { createWalletApp, type CreateWalletAppOptions, type DevstackDappKit } from './wallet-app.js';
export {
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusOptionsInit,
} from './walrus.js';
