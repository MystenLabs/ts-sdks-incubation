// Plugin-author tier — primitives for building new domain plugins.
// User configs should not import from here directly.

// Three tag primitives, in preference order:
//
// - `provide(InterfaceTag, build)` — use when your factory IS an
//   implementation of a shared interface (e.g. `suiLocalnet` provides
//   `Sui`, `deepbookKnownPackage` provides `Deepbook`). Import the
//   interface tag from `@mysten-incubation/devstack` and pass it
//   as the first argument. Multiple factories targeting the same
//   interface share one Context.Service class.
//
// - `tag(name, build)` — use for one-off tags that DON'T share an
//   interface: per-account tags from `accounts()`, custom user plugins,
//   `action`, `tx`, etc. Creates a throwaway Context.Service class
//   internally; sugar over `provide`.
//
// - `composeLayers({primary, inner, projections})` — for multi-layer
//   StackMembers that aggregate sibling inner tags into one LayeredTag. Used
//   by walrusLocalCluster (multi-interface acquire body) and
//   sealLocalKeygen (internal tag + two projection layers) to assemble
//   their `__layers` arrays without hand-rolling ordering.
export {
	provide,
	tag,
	composeLayers,
	setPhase,
	type ComposeLayersOptions,
	type LayeredTag,
	type TagIdentity,
	type TagOptions,
} from '../tag.js';
export { dockerImage, type DockerImage, type DockerImageOptions } from './docker-image.js';
export {
	dockerContainer,
	runDockerContainer,
	type DockerContainerImage,
	type DockerContainerMount,
	type DockerContainerRouting,
	type DockerContainerEndpoint,
	type DockerContainerOptions,
	type DockerContainerOptionsInput,
	type DockerContainerHandle,
} from './docker-container.js';
export {
	dockerOneShot,
	type DockerOneShotOptions,
	type DockerOneShotResult,
} from './docker-one-shot.js';
export { gitFetch, GitFetchError, type GitFetched, type GitFetchOptions } from './git-fetch.js';
export { hostScript, type HostScriptOptions, type HostScriptResult } from './host-script.js';

// Registries — surfaced so plugin-author code can call the `publish*`
// write helpers and the `require*` ordering helpers without reaching
// into `../internal/`. The `Live` layers and the bare `RegistryShape`
// snapshot interface stay internal; authors should treat each registry
// as a black box and use the typed helpers.
export {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
	publishAccount,
	publishCoin,
	publishEndpoint,
	publishPackage,
	requireAccountRegistry,
	requireCoinRegistry,
	requireEndpointRegistry,
	requirePackageRegistry,
	type AccountRecord,
	type CoinRecord,
	type EndpointRecord,
	type PackageRecord,
} from '../../engine/registries.js';

// Router entrypoint registry — plugin authors that surface a new
// traefik entrypoint port (e.g. a Prometheus-metrics-only endpoint)
// register it via `defineEntrypoint(...)` from their module top
// level so the registration lands before the supervisor boots
// traefik. `routerEntrypoint(name)` reads back a registered entry
// (port + default protocol) for downstream URL composition.
export {
	defineEntrypoint,
	listEntrypoints,
	routerEntrypoint,
	type RouterEntrypoint,
} from '../../engine/docker/router.js';
