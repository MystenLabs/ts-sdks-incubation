// React adapter public barrel. Apps import from
// `@mysten-incubation/devstack/react`. Peer deps (`react`,
// `@mysten/dapp-kit-react`) are optional — the rest of devstack stays
// usable without them.
//
// Surface is intentionally minimal and manifest-driven. Generic SDK
// patterns (signing transactions, binding codegen modules) live in
// `@mysten/dapp-kit-react` / `@mysten/codegen` directly; devstack
// just supplies the localnet config inputs that get spread into
// `createDAppKit({...})` and `new WalrusClient({...})`.

export { DevstackProvider, type DevstackProviderProps } from './provider.js';
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
// `useSignAndExecute` — generic sign + waitForTransaction + invalidate
// helper. Extracted from the 4 example apps' `lib/queries.ts` where it
// had drifted into byte-identical copies; apps still wrap their app-
// specific keys via `invalidateKeys`.
export {
	useSignAndExecute,
	type UseSignAndExecuteOptions,
} from './use-sign-and-execute.js';
