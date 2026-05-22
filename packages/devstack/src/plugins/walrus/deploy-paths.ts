import { dirname, join, relative } from 'node:path';

export interface WalrusDeployMountPaths {
	readonly sourceHostPath: string;
	readonly mountTarget: string;
	readonly outputDirInContainer: string;
}

export const walrusDeployMountPaths = (
	deployOutputDirHostPath: string,
	mountTarget: string,
): WalrusDeployMountPaths => {
	const sourceHostPath = dirname(dirname(dirname(deployOutputDirHostPath)));
	const outputDirInContainer = join(mountTarget, relative(sourceHostPath, deployOutputDirHostPath));
	return { sourceHostPath, mountTarget, outputDirInContainer };
};
