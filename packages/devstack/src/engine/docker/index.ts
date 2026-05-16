// Effect-flavored thin wrapper around the `docker` CLI.
//
// Ported from `packages/devstack/src/runners/docker-container.ts` (and
// docker-image.ts / docker-network.ts) but adapted to Effect v4 idioms:
//
//   - Subprocess work goes through `effect/unstable/process`'s
//     `ChildProcessSpawner` (Node binding provided upstream by the
//     `NodeChildProcessSpawner` layer).
//   - Long-running resources (`run`, `networkCreate`) register a
//     `Scope.addFinalizer` so the engine's reverse-topo shutdown order
//     keeps containers cleaned up before networks.
//   - All failures funnel through a single tagged `DockerError`.
//
// Internal consumers import the public surface as
// `import * as Docker from '../engine/docker.js'`; this barrel
// re-exports each slice's public symbol so that pattern keeps working.

export { DockerError } from '../../engine/errors.js';
export {
	run,
	type DockerRunOptions,
	type DockerRunResult,
	type DockerExecResult,
	type OutputLineCallback,
	type OutputLineLevel,
	composeContainerName,
	composeProjectName,
} from './core.js';
export {
	pull,
	build,
	saveImage,
	loadImage,
	tagImage,
	imageExists,
	inspectContainerImage,
	type DockerPullResult,
	type DockerBuildOptions,
	type DockerBuildResult,
	type DockerLoadResult,
} from './image.js';
export {
	exec,
	commitContainer,
	restartContainer,
	runOneShot,
	type DockerCommitResult,
	type DockerOneShotOptions,
	type DockerOneShotResult,
} from './exec.js';
export { networkCreate, networkConnect } from './network.js';
export { awaitContainerReady, dockerLogsTail, dockerWait, followLogs } from './logs.js';
export { ClaimedContainers, dockerOrphanSweep } from './sweep.js';
export { reallocatePortsOnConflict } from './port-conflict.js';
export {
	ensureRouter,
	ROUTER_NETWORK,
	ROUTER_CONTAINER,
	ROUTER_IMAGE,
	ROUTER_ENTRYPOINTS,
	routerEntrypoint,
	routerDynamicDir,
	renderFileProvider,
	writeFileProvider,
	removeFileProvider,
	getTraefikRouterIp,
	type RouterLabel,
	type RouterEntrypoint,
	type FileProviderEntry,
} from './router.js';
