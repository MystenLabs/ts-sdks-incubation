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
	useDevstackContext,
	useDevstackManifest,
	type DevstackProviderProps,
} from './provider.js';
export { useDevstackDeployed, type UseDevstackDeployedOptions } from './use-devstack-deployed.js';
export { bindPackage, type CodegenModule } from './bind-package.js';
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
