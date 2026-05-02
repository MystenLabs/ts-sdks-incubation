// Public barrel for `@mysten-incubation/devstack/runtime`. Surfaces the
// reconciler, supervisor, registry, file watcher, status renderer,
// topo/hash helpers, manifest I/O, one-shot driver, and active-stack
// utilities. Imported by devstack itself and by advanced embedders that
// want to drive the action graph from custom CLIs or test harnesses.
//
// The main `@mysten-incubation/devstack` barrel re-exports these for
// back-compat; new code should prefer the subpath import to keep the
// authoring surface (`definePlugin`, action factories, types) clear.

export { Reconciler } from './runtime/reconcile.js';
export type {
	ReconcileBaseContext,
	ReconcileResult,
	ReconcileProgress,
} from './runtime/reconcile.js';
export { stableHash } from './runtime/hash.js';
export { topoSortActions, type TopoSortOptions } from './runtime/topo.js';
export {
	buildManifest,
	manifestPath,
	writeManifest,
	type Manifest,
	type SerializedRegistry,
	type WriteManifestOptions,
} from './runtime/manifest-writer.js';
export { hydrateRegistry, readManifest } from './runtime/manifest-reader.js';
export { Supervisor, type SupervisorOptions } from './runtime/supervisor.js';
export { StatusRenderer, type StatusRendererOptions } from './runtime/status-renderer.js';
export { FileWatcher, type FileWatcherOptions } from './runtime/file-watcher.js';
export { runOneShot, type OneShotOptions, type OneShotResult } from './runtime/one-shot.js';
export { resolveAccounts, type ResolveAccountsOptions } from './runtime/accounts.js';
export {
	DEFAULT_STACK,
	TEST_STACK,
	activeStackFile,
	readActiveStack,
	resolveStack,
	stackDir,
	writeActiveStack,
} from './runtime/active-stack.js';
/** @internal — concrete Registry implementation. Embedders should
 * normally consume the `Registry` interface (the supervisor / reconciler
 * hands one to plugin actions). Re-exported here for test harnesses
 * that need to construct one directly; not part of the stable surface. */
export { RegistryImpl } from './registry/index.js';
