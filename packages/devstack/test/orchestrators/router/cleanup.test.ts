import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	removeRouterDispatchFilesForStack,
	removeRouterProfileStateForDockerStack,
} from '../../../src/orchestrators/router/cleanup.ts';

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'devstack-router-cleanup-'));

describe('router cleanup', () => {
	it.effect('removes dispatch route files owned by a wiped stack', () =>
		Effect.gen(function* () {
			const root = tempRoot();
			try {
				const dispatchDir = join(root, 'router', 'uid-501-deadbeef', 'dispatch');
				mkdirSync(dispatchDir, { recursive: true });
				const routeFile = join(dispatchDir, '10-r1-demo.yml');
				const otherFile = join(dispatchDir, '10-r1-other.yml');
				writeFileSync(
					routeFile,
					[
						'# dispatchFileId: r1-demo',
						'# wireProtocol: http',
						'# entrypointName: rpc',
						'# entrypointPort: 9000',
						'# hostname: rpc.private-content.private-content.localhost',
						'# routeLeaseVersion: 1',
						'# routerProfileId: uid-501-deadbeef',
						'# ownerApp: private-content',
						'# ownerStack: private-content',
						'# ownerPid: 123',
						'# ownerStartTime: 456',
						'# ownerHostname: test-host',
						'# ownerClaimedAt: 1',
						'# ownerHeartbeatAt: 1',
						'# ownerIntent: normal',
						'http: {}',
					].join('\n'),
				);
				writeFileSync(
					otherFile,
					[
						'# dispatchFileId: r1-other',
						'# wireProtocol: http',
						'# entrypointName: rpc',
						'# entrypointPort: 9000',
						'# hostname: rpc.other.other.localhost',
						'# routeLeaseVersion: 1',
						'# routerProfileId: uid-501-deadbeef',
						'# ownerApp: other',
						'# ownerStack: other',
						'# ownerPid: 123',
						'# ownerStartTime: 456',
						'# ownerHostname: test-host',
						'# ownerClaimedAt: 1',
						'# ownerHeartbeatAt: 1',
						'# ownerIntent: normal',
						'http: {}',
					].join('\n'),
				);

				const removed = yield* removeRouterDispatchFilesForStack({
					runtimeRoot: root,
					app: 'private-content',
					stack: 'private-content',
				}).pipe(Effect.provide(NodeFileSystem.layer));

				expect(removed).toBe(1);
				expect(existsSync(routeFile)).toBe(false);
				expect(existsSync(otherFile)).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('removes the router profile state matching a stale router container', () =>
		Effect.gen(function* () {
			const root = tempRoot();
			try {
				const stateDir = join(root, 'router', 'uid-501-deadbeef');
				mkdirSync(stateDir, { recursive: true });

				const removed = yield* removeRouterProfileStateForDockerStack({
					runtimeRoot: root,
					routerStack: 'devstack-router-deadbeef',
				}).pipe(Effect.provide(NodeFileSystem.layer));

				expect(removed).toBe(1);
				expect(existsSync(stateDir)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
