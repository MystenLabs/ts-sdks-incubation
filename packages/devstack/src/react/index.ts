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
// in `plugins/codegen/mvr.ts` (a side-effect-free file) so re-exporting
// from the browser-facing `/react` barrel doesn't drag the codegen
// plugin's Node-only deps (`node:child_process`, `@mysten/codegen`'s
// emitter) into the browser bundle.
export { defaultMvrName } from '../plugins/codegen/mvr.js';
