import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';

import { dispatchFileIdFromFilename, parseDispatchRouteFile } from './file-provider.ts';

export const ROUTER_SHARED_APP = 'devstack-router';
export const ROUTER_CONTAINER_NAME_PREFIX = 'devstack-router-';

const routerStateRoot = (runtimeRoot: string): string => join(runtimeRoot, 'router');

const safeDirectories = (dir: string): ReadonlyArray<string> => {
	try {
		return readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory());
	} catch {
		return [];
	}
};

export const removeRouterDispatchFilesForStack = (inputs: {
	readonly runtimeRoot: string;
	readonly app: string;
	readonly stack: string;
}): Effect.Effect<number> =>
	Effect.sync(() => {
		let removed = 0;
		for (const profileDir of safeDirectories(routerStateRoot(inputs.runtimeRoot))) {
			const dispatchDir = join(routerStateRoot(inputs.runtimeRoot), profileDir, 'dispatch');
			if (!existsSync(dispatchDir)) continue;
			for (const filename of readdirSync(dispatchDir)) {
				const dispatchFileId = dispatchFileIdFromFilename(filename);
				if (dispatchFileId === null) continue;
				const file = join(dispatchDir, filename);
				let body: string;
				try {
					body = readFileSync(file, 'utf8');
				} catch {
					continue;
				}
				const parsed = parseDispatchRouteFile(body, dispatchFileId);
				if (
					parsed._tag === 'valid' &&
					parsed.route.lease?.app === inputs.app &&
					parsed.route.lease.stack === inputs.stack
				) {
					rmSync(file, { force: true });
					removed += 1;
				}
			}
		}
		return removed;
	});

export const removeRouterProfileStateForDockerStack = (inputs: {
	readonly runtimeRoot: string;
	readonly routerStack: string;
}): Effect.Effect<number> =>
	Effect.sync(() => {
		if (!inputs.routerStack.startsWith(ROUTER_CONTAINER_NAME_PREFIX)) return 0;
		const fingerprint = inputs.routerStack.slice(ROUTER_CONTAINER_NAME_PREFIX.length);
		if (fingerprint.length === 0) return 0;

		let removed = 0;
		for (const profileDir of safeDirectories(routerStateRoot(inputs.runtimeRoot))) {
			if (!profileDir.endsWith(`-${fingerprint}`)) continue;
			rmSync(join(routerStateRoot(inputs.runtimeRoot), profileDir), {
				recursive: true,
				force: true,
			});
			removed += 1;
		}
		return removed;
	});
