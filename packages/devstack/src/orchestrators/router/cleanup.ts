import { join } from 'node:path';

import { Effect, FileSystem } from 'effect';

import { dispatchFileIdFromFilename, parseDispatchRouteFile } from './file-provider.ts';

export const ROUTER_SHARED_APP = 'devstack-router';
export const ROUTER_CONTAINER_NAME_PREFIX = 'devstack-router-';

const routerStateRoot = (runtimeRoot: string): string => join(runtimeRoot, 'router');

const safeDirectories = (
	fs: FileSystem.FileSystem,
	dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const entries = yield* fs
			.readDirectory(dir)
			.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
		const directories: Array<string> = [];
		for (const entry of entries) {
			const stat = yield* fs.stat(join(dir, entry)).pipe(Effect.catch(() => Effect.succeed(null)));
			if (stat !== null && stat.type === 'Directory') {
				directories.push(entry);
			}
		}
		return directories;
	});

export const removeRouterDispatchFilesForStack = (inputs: {
	readonly runtimeRoot: string;
	readonly app: string;
	readonly stack: string;
}): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		let removed = 0;
		for (const profileDir of yield* safeDirectories(fs, routerStateRoot(inputs.runtimeRoot))) {
			const dispatchDir = join(routerStateRoot(inputs.runtimeRoot), profileDir, 'dispatch');
			const exists = yield* fs.exists(dispatchDir).pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) continue;
			const filenames = yield* fs
				.readDirectory(dispatchDir)
				.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
			for (const filename of filenames) {
				const dispatchFileId = dispatchFileIdFromFilename(filename);
				if (dispatchFileId === null) continue;
				const file = join(dispatchDir, filename);
				const body = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(null)));
				if (body === null) continue;
				const parsed = parseDispatchRouteFile(body, dispatchFileId);
				if (
					parsed._tag === 'valid' &&
					parsed.route.lease?.app === inputs.app &&
					parsed.route.lease.stack === inputs.stack
				) {
					yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
					removed += 1;
				}
			}
		}
		return removed;
	});

export const removeRouterProfileStateForDockerStack = (inputs: {
	readonly runtimeRoot: string;
	readonly routerStack: string;
}): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (!inputs.routerStack.startsWith(ROUTER_CONTAINER_NAME_PREFIX)) return 0;
		const fingerprint = inputs.routerStack.slice(ROUTER_CONTAINER_NAME_PREFIX.length);
		if (fingerprint.length === 0) return 0;

		const fs = yield* FileSystem.FileSystem;
		let removed = 0;
		for (const profileDir of yield* safeDirectories(fs, routerStateRoot(inputs.runtimeRoot))) {
			if (!profileDir.endsWith(`-${fingerprint}`)) continue;
			yield* fs
				.remove(join(routerStateRoot(inputs.runtimeRoot), profileDir), {
					recursive: true,
					force: true,
				})
				.pipe(Effect.ignore);
			removed += 1;
		}
		return removed;
	});
