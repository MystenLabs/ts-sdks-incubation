// Docker runtime — barrel.
//
// L1 reference implementation of the `ContainerRuntime` capability.
// Third parties writing a podman / finch / nerdctl backend follow the
// same shape: `service.ts` exposes a `Context.Service` projecting the
// contract; the rest is the implementation seam.

// Public service surface
export {
	ContainerRuntimeService,
	DockerCycle,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
} from './service.ts';

// Configuration / wiring services
export { DockerHost, DockerSpawner, layerDockerHost, layerDockerHostDefault } from './client.ts';

// Typed errors — plugins that want precise tags can catchTag on these
// BEFORE the contract projection collapses them to the narrow envelope.
export {
	BuildFailed,
	ContainerCreateFailed,
	ContainerExited,
	ContainerNameCollisionUnrecoverable,
	ContainerRemoveFailed,
	DaemonUnreachable,
	DockerInspectDecodeFailed,
	DockerInspectFailed,
	type DockerRuntimeError,
	ExecFailed,
	ForeignDockerResource,
	ImageLoadFailed,
	ImageNotFound,
	ImagePullFailed,
	ImageSaveFailed,
	ImageTagFailed,
	NetworkIpReadbackTimeout,
	NetworkOperationFailed,
	RecreateRefused,
	VolumeOperationFailed,
} from './errors.ts';

// Subsystems — useful for advanced consumers (snapshot orchestrator,
// CLI inventory commands) that want to bypass the contract projection.
export {
	commit,
	decideRunAction,
	ensureContainer,
	inspectContainer,
	pause,
	type RunAction,
	stop,
	unpause,
} from './container.ts';

export {
	dockerExec,
	type DockerExecOptions,
	type DockerExecResult,
	dockerRunOneShot,
	type DockerOneShotOptions,
} from './exec.ts';

export {
	build,
	type BuildOptions,
	type CachedBuildKey,
	ensureImageCached,
	imageExists,
	inspectDigest,
	loadImage,
	pull,
	refOf,
	saveImage,
	type TagImageOptions,
	tagImage,
} from './image.ts';

export {
	type ContainerSummary,
	type ImageSummary,
	listDevstackContainers,
	listDevstackImages,
	listDevstackNetworks,
	listDevstackVolumes,
	listContainers,
	listImages,
	listNetworks,
	listVolumes,
	type NetworkSummary,
	type VolumeSummary,
} from './inventory.ts';

export { followLogs, type FollowLogsOptions, logTail } from './logs.ts';

export {
	connect,
	disconnect,
	ensureNetwork,
	type EnsureNetworkOptions,
	readIps,
	SHARED_NETWORK_NAME,
	waitForIp,
	type WaitForIpOptions,
} from './network.ts';

export {
	removeDevstackContainers,
	removeDevstackImages,
	removeDevstackNetworks,
	removeDevstackNetworksBestEffort,
	removeDevstackVolumes,
	removeManagedContainers,
	removeManagedImages,
	removeManagedNetworks,
	removeManagedVolumes,
	sweepOrphans,
	type DevstackNetworkRemovalSummary,
} from './sweep.ts';

export { ensureVolume, removeVolume } from './volume.ts';

// Label contract — exported so the supervisor / sweep / inventory in
// sibling packages can spell labels the same way.
export {
	COMPOSE_UI_VERSION,
	ComposeLabelKey,
	LabelKey,
	composeProjectId,
	composeServiceId,
	renderComposeContainerLabels,
	renderComposeNetworkLabels,
	renderComposeVolumeLabels,
	expectedContainerOwnershipLabels,
	expectedNetworkOwnershipLabels,
	expectedVolumeOwnershipLabels,
	ownershipMismatchDetail,
	renderContainerLabels,
	renderFilterArgs,
	renderNetworkLabels,
	renderVolumeLabels,
} from './labels.ts';

// Stderr classifiers — useful for plugin authors who want to surface
// "port conflict" or "no such container" themselves (e.g. resume-
// fallback port handling in a custom plugin).
export {
	isAlreadyInNetworkStderr,
	isDaemonUnreachableStderr,
	isImageNotFoundStderr,
	isNameCollisionStderr,
	isNoSuchContainerStderr,
	isPortConflictStderr,
} from './wrap.ts';
