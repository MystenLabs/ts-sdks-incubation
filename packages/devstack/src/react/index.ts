// React adapter public barrel. Apps import from
// `@mysten-incubation/devstack/react`. Peer deps (`react`,
// `react-dom`, `@mysten/dapp-kit-react`, `@tanstack/react-query`)
// are optional — the rest of devstack stays usable without them.

export { bindPackage } from './bind-package.js';
export {
	DevstackProvider,
	useDevstackContext,
	useDevstackManifest,
	type DevstackProviderProps,
} from './provider.js';
export { useDevstackPackage, useDevstackPackageOptional } from './use-devstack-package.js';
export { useDevstackDeployed, type UseDevstackDeployedOptions } from './use-devstack-deployed.js';
export {
	useDevstackSignAndExecute,
	type UseDevstackSignAndExecuteOptions,
} from './use-devstack-sign-and-execute.js';
export type { CodegenModule, DevstackPackageRegistry, DevstackProviderState } from './types.js';
export {
	createDevstackDappKit,
	type CreateDevstackDappKitOptions,
	type DevKey,
	type DevWalletInitializerFactory,
} from './create-devstack-dapp-kit.js';
export { DevstackDebugPanel, type DevstackDebugPanelProps } from './debug-panel.js';
