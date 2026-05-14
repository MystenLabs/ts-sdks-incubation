// React subpath public barrel. Apps import from
// `@mysten-incubation/devstack/dapp-kit`. Peer deps (`react`,
// `@mysten/dapp-kit-react`) are optional — the rest of devstack
// stays usable without them.

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
export { localnetWalrusOptions, type LocalnetWalrusOptions } from './walrus.js';
