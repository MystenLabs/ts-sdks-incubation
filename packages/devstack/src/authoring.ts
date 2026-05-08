// Plugin-authoring primitives.
//
// App authors should NOT import from this subpath — use the main barrel
// (`@mysten-incubation/devstack`). This subpath is for third parties writing
// custom devstack plugins.
//
// STABILITY: this subpath re-exports internal helpers (docker primitives,
// action factories, runtime types). Until devstack reaches 1.0, the shapes
// here are not guaranteed stable across minor versions. Plugin authors
// should pin a specific @mysten-incubation/devstack version range in their
// peerDependencies and validate against new releases. Track changes via
// `notes/friction.md` in the devstack source tree.
//
// It exposes:
//
//   definePlugin    — Identity helper for typed plugin authoring.
//   buildImage      — Build action factory (docker images).
//   service         — Generic Service action factory.
//   containerService — Service action factory for docker containers
//                     (snapshot wiring + container labels baked in).
//   hostProcess     — Service-equivalent for in-process children
//                     (vite, http listeners) whose lifecycle is bound
//                     to the supervisor process.
//   publish         — Move package publish action factory.
//   register        — Register action factory (chain-bound side effects).
//   emit            — Emit action factory (codegen-style derived outputs).
//   verify          — Verify action factory (read-only invariant checks).
//
// Plus type-only re-exports of the action / context / snapshot
// definitions, and the docker primitives a `containerService` spec
// callback needs (so plugin authors don't have to reach into a
// sibling plugin's source).
//
// The ergonomic wrappers used in `defineDevstackConfig({ use: [...] })`
// (publishMove, runTransaction, seed, registerCoin) live in the main
// barrel — they're for app authors. The factories here are the lower-
// level primitives those wrappers build on.

export { definePlugin } from './plugin.js';
export { buildImage, type BuildImageOptions } from './actions/build.js';
export { service, type ServiceOptions } from './actions/service.js';
export {
	containerService,
	type ContainerServiceOptions,
} from './actions/container-service.js';
export { hostProcess, type HostProcessOptions } from './actions/host-process.js';
export { publish, type PublishInputs, type PublishOptions } from './actions/publish.js';
export { register, type RegisterOptions } from './actions/register.js';
export { emit, type EmitOptions } from './actions/emit.js';
export { verify, type VerifyOptions } from './actions/verify.js';

// Custom registry kinds. Plugin authors who introduce a new
// `<plugin>.<kind>` namespace (e.g. `myStorage.buckets`) call this
// helper to mint the typed accessor. The main barrel also re-exports
// it for app-level use.
export { defineRegistryKind } from './registry/index.js';

// Type-only re-exports for plugin authors writing typed plugins. The
// live-net context (`LiveNetActionRunContext`) is intentionally NOT
// re-exported — plugin authors who need both branches narrow on the
// `ActionRunContext` union directly and the localnet branch is the
// only one most plugins ever materialize a name for.
export type {
	// Action shapes
	Action,
	BuildAction,
	ServiceAction,
	HostProcessAction,
	PublishAction,
	RegisterAction,
	SeedAction,
	EmitAction,
	VerifyAction,
	// Plugin shape (typed `provides` flows into `defineDevstackConfig`)
	Plugin,
	// Action context + lifecycle
	ActionRunContext,
	LocalnetActionRunContext,
	ShutdownHook,
	ActionStatus,
	ActionType,
	PortAllocator,
	SnapshotMeta,
	// Capability surface (`provides:` on action factories)
	Provides,
	// Network targeting
	Network,
	// Accounts handle on `ctx.accounts`
	AccountsContext,
	// Registry handle on `ctx.registry` + the per-kind query shape
	Registry,
	RegistryQuery,
	// Built-in registry-kind shapes (Token lives in `coin.tokens`)
	Token,
} from './core/types.js';

// Localnet narrowing helper. Plugin authors call this at the top of
// Register/Seed/Emit callbacks that materially require localnet.
export { requireLocalnetCtx } from './runtime/runtime-helpers.js';

// Test-only helper that synthesizes a real `ActionRunContext` for plugin
// unit tests — saves authors hand-stubbing `Registry`/`AccountsContext`/
// `PortAllocator`/`appendLog` themselves.
export {
	createTestActionContext,
	type CreateTestActionContextOptions,
} from './runtime/test-context.js';

// Docker primitives — the curated surface a plugin author needs to
// write a `containerService(spec)` callback. These live in
// `runtime/docker/*` so consumers don't reach into the sui plugin's
// source directory.
//
// Internal devstack code (snapshot save/restore, `wipe --images`, the
// walrus subnet probe) imports from the leaf docker modules directly
// (`./runtime/docker/run.js`, `./images.js`, `./network.js`) — those
// helpers are intentionally NOT re-exported here so the plugin-
// authoring surface stays minimal.
export {
	// Container lifecycle
	type ContainerInfo,
	type RunContainerOptions,
	inspectContainer,
	readContainerFile,
	removeContainer,
	runContainer,
	startContainer,
	stopContainer,
	waitForContainerExit,
	waitForHealthy,
	// Low-level `docker build` wrapper. Used inside a Build action's `run`
	// callback when the plugin ships its own Dockerfile (vs. pulling a
	// public image). Distinct from the Build-action factory `buildImage`
	// re-exported above.
	buildContainerImage,
	type BuildContainerImageOptions,
	// Image probes + cache management (a Build action's `getStatus` typically
	// calls `imageExists`; `pruneImagesByLabel` / `listImagesByLabel` are
	// for plugins implementing `-rN` ratchet GC).
	imageExists,
	listImagesByLabel,
	pruneImagesByLabel,
	removeImage,
	// Network ops + the per-(app, stack) network-name builder
	appNetworkName,
	ensureNetwork,
	removeNetwork,
	// Daemon pre-flight
	DockerDaemonError,
	hostDockerPlatform,
	requireDockerDaemon,
	// Container labels — devstack's CLI filters resources by these
	devstackContainerLabels,
} from './runtime/docker/index.js';

// Probe helpers (used by all real Service plugins).
export { pollUntilReady } from './helpers/poll.js';
export { probeUrl, waitForReachable } from './helpers/probe.js';
