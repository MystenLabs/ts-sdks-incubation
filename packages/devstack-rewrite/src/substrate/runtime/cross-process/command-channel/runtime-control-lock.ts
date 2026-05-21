import { dirname } from 'node:path';

export const RUNTIME_CONTROL_LOCK_FILE_SUFFIX = '.runtime-control.lock';

export const runtimeControlLockPathForStackRoot = (stackRoot: string): string =>
	`${stackRoot}${RUNTIME_CONTROL_LOCK_FILE_SUFFIX}`;

export const runtimeControlLockPathForChannelFile = (path: string): string =>
	runtimeControlLockPathForStackRoot(dirname(path));
