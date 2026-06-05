import { join, relative } from 'node:path';

export interface WalrusDeployMountPaths {
	readonly sourceHostPath: string;
	readonly mountTarget: string;
	readonly outputDirInContainer: string;
}

/** Compute the bind-mount triple shared by the walrus deploy
 *  one-shot + storage nodes.
 *
 *  Previous implementation walked up exactly three levels with
 *  `dirname(dirname(dirname(deployOutputDirHostPath)))`. A shorter
 *  input (e.g. a single-segment path under `/`) would silently
 *  return `/`, and the bind-mount would mount the host root into
 *  the container — a load-bearing footgun. We now require the
 *  caller to pass `stackRoot` explicitly and assert the deploy dir
 *  lives under it.
 *
 *  The mount source is `stackRoot`; the in-container path is
 *  re-derived through `relative(stackRoot, deployOutputDirHostPath)`. */
export const walrusDeployMountPaths = (input: {
	readonly stackRoot: string;
	readonly deployOutputDirHostPath: string;
	readonly mountTarget: string;
}): WalrusDeployMountPaths => {
	const { stackRoot, deployOutputDirHostPath, mountTarget } = input;
	const rel = relative(stackRoot, deployOutputDirHostPath);
	if (rel.length === 0 || rel.startsWith('..')) {
		throw new Error(
			`walrusDeployMountPaths: deployOutputDirHostPath (${deployOutputDirHostPath}) ` +
				`must be a descendant of stackRoot (${stackRoot}). ` +
				`Cross-check the StackPathsService thread + the deploy directory layout.`,
		);
	}
	const outputDirInContainer = join(mountTarget, rel);
	return { sourceHostPath: stackRoot, mountTarget, outputDirInContainer };
};
