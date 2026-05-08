// Generic docker primitives. Lives outside `plugins/*` so plugin
// authors can import these from the package's `/authoring` barrel
// without reaching into a sibling plugin's source.
//
// This barrel is the curated `/authoring` surface. Internal callers
// (`cli/stack.ts`'s `wipe --images`, the walrus subnet probe, the
// containers test) import from the leaf modules (`./images.js`,
// `./network.js`, `./containers.js`) directly so the public surface
// stays tight.

export {
	type BuildContainerImageOptions,
	buildContainerImage,
	imageExists,
	listImagesByLabel,
	pruneImagesByLabel,
	removeImage,
} from './images.js';

export {
	DockerDaemonError,
	hostDockerPlatform,
	requireDockerDaemon,
} from './daemon.js';

export {
	appNetworkName,
	ensureNetwork,
	removeNetwork,
} from './network.js';

export {
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
} from './containers.js';

export { DEVSTACK_IMAGE_NAMESPACE, devstackContainerLabels } from './labels.js';
