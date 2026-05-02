// React adapter public barrel. Apps import from
// `@mysten-incubation/devstack/react`. Peer deps (`react`,
// `react-dom`, `@mysten/dapp-kit-react`) are optional — the rest of
// devstack stays usable without them.
//
// Surface is intentionally minimal and manifest-driven. Generic SDK
// patterns (signing transactions, binding codegen modules) live in
// `@mysten/dapp-kit-react` / `@mysten/codegen` directly; devstack
// just supplies the localnet config inputs that get spread into
// `createDAppKit({...})` and `new WalrusClient({...})`. See
// `notes/react-api-investigation.md` for the rationale.

export {
	DevstackProvider,
	useDevstackManifest,
	type DevstackProviderProps,
} from './provider.js';
export { useDevstackDeployed, type UseDevstackDeployedOptions } from './use-devstack-deployed.js';
export type { DevstackProviderState } from './types.js';
export {
	localnetDappKitConfig,
	localnetMvrOverrides,
	type LocalnetDappKitConfig,
	type LocalnetDappKitConfigOptions,
	type LocalnetMvrOverrides,
} from './create-devstack-dapp-kit.js';
export {
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusOptionsInit,
} from './walrus.js';
// `defaultMvrName` is the placeholder mapper apps pair with
// `localnetDappKitConfig({ mvrName })` and `codegen({ mvrName })`. Lives
// on the codegen plugin internally; re-exported here so apps that only
// import from `/react` don't need a second import path.
export { defaultMvrName } from '../plugins/codegen/index.js';
