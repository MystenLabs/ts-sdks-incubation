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
// - `composeTag(name, build, innerTags)` — composite-tag sugar. Use
//   when you want a single outer tag whose body yields from inner
//   sibling tags. Aggregates the inner tags' layers automatically.
//
// - `composeLayers({primary, inner, projections})` — for multi-layer
//   StackMembers that DON'T want a new outer tag class. Used by
//   walrusLocalCluster (multi-interface acquire body) and
//   sealLocalKeygen (internal tag + two projection layers) to assemble
//   their `__layers` arrays without hand-rolling ordering.
export {
	provide,
	tag,
	composeTag,
	composeLayers,
	setPhase,
	type ComposeLayersOptions,
	type Ref,
	type TagIdentity,
	type TagOptions,
	type TagRequires,
	type TagErrors,
	type TagProvides,
} from '../tag.js';
export { dockerImage, type DockerImage, type DockerImageOptions } from './docker-image.js';
export {
	dockerOneShot,
	type DockerOneShotOptions,
	type DockerOneShotResult,
} from './docker-one-shot.js';
export { gitFetch, GitFetchError, type GitFetched, type GitFetchOptions } from './git-fetch.js';
export { hostScript, type HostScriptOptions, type HostScriptResult } from './host-script.js';

// Registries — surfaced so plugin-author code can `publish(...)` /
// `requiring(...)` without reaching into `../internal/`. The `Live`
// layers and the bare `RegistryShape` snapshot interface stay internal;
// authors should treat each registry as a black box and use the typed
// helpers.
export {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
	type AccountRecord,
	type CoinRecord,
	type EndpointRecord,
	type PackageRecord,
} from '../../engine/registries.js';

// Cache — thin facade over the internal StateStore for plugin authors
// that need to memoize expensive setup work (e.g. dockerOneShot keygen).
// Pluging authors should NOT import StateStore directly.
export { cacheGet, cachePut, cacheRemove } from '../../engine/cache.js';
