import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';

import { definePlugin } from '../../src/api/define-plugin.ts';
import type { LivenessClassifierDecl } from '../../src/contracts/liveness-classifier.ts';
import type { SnapshotableDecl } from '../../src/contracts/snapshotable.ts';
import type {
	SnapshotCatalogEntry,
	SnapshotMetadata,
} from '../../src/orchestrators/snapshot/index.ts';
import { StackPathsService } from '../../src/substrate/runtime/paths.ts';
import { runBoot } from './boot-config-impl.ts';

const snapshotDecl: SnapshotableDecl = {
	kind: 'snapshotable',
	subtrees: [],
	managedContainers: [],
	preRestore: Effect.succeed({ kind: 'snapshot-smoke' as const }),
	missingTolerance: 'fine',
};

const livenessDecl: LivenessClassifierDecl = {
	kind: 'liveness-classifier',
	classify: () => Effect.succeed('alive'),
};

const snapshotSmokePlugin = definePlugin({
	id: 'snapshot-smoke',
	role: 'service' as const,
	section: 'service',
	start: () => Effect.succeed({ ready: true as const }),
	capabilities: [snapshotDecl, livenessDecl] as const,
});

const stack = {
	members: [snapshotSmokePlugin],
	options: {},
};

const hostTreePlugin = definePlugin({
	id: 'snapshot-host-tree',
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const paths = yield* StackPathsService;
			const dir = join(paths.stackRoot, 'snapshot-host-tree');
			const file = join(dir, 'payload.txt');
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, 'original contents\n');
			return { dir, file };
		}),
	capabilities: ({ runtime }) =>
		[
			{
				kind: 'snapshotable' as const,
				subtrees: ['snapshot-host-tree'],
				managedContainers: [],
				missingTolerance: 'fatal' as const,
				preRestore: Effect.succeed({
					kind: 'snapshot-host-tree' as const,
					app: runtime.identity.app,
					stack: runtime.identity.stack,
					network: runtime.chain,
				}),
			},
			livenessDecl,
		] as const,
});

const hostTreeStack = {
	members: [hostTreePlugin],
	options: {},
};

describe('snapshot orchestrator wiring in runBoot', () => {
	it('registers snapshotable contributions through the real service', async () => {
		const observed: {
			captureExit: Exit.Exit<SnapshotMetadata, unknown> | null;
			listExit: Exit.Exit<ReadonlyArray<SnapshotCatalogEntry>, unknown> | null;
		} = {
			captureExit: null,
			listExit: null,
		};

		const result = await runBoot({
			stack,
			appName: 'snapshot-orchestrator-smoke',
			stackName: 'main',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					observed.captureExit = yield* Effect.exit(
						ctx.snapshot.captureMetadata('registration-smoke'),
					);
					observed.listExit = yield* Effect.exit(ctx.snapshot.list);
				}),
		});

		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys]).toEqual(['snapshot-smoke#0']);

		const captureExit = observed.captureExit;
		expect(captureExit).not.toBeNull();
		if (captureExit === null) return;
		expect(Exit.isSuccess(captureExit)).toBe(true);
		if (!Exit.isSuccess(captureExit)) return;

		expect(captureExit.value.id).toBe('registration-smoke');
		expect(captureExit.value.participants).toEqual(['snapshot-smoke#0']);
		expect(captureExit.value.hostTreeIncluded).toBe(false);
		expect(captureExit.value.subtrees).toEqual([]);
		expect(captureExit.value.containers).toEqual([]);

		const listExit = observed.listExit;
		expect(listExit).not.toBeNull();
		if (listExit === null) return;
		expect(Exit.isSuccess(listExit)).toBe(true);
		if (!Exit.isSuccess(listExit)) return;

		const entry = listExit.value.find((item) => item.id === 'registration-smoke');
		expect(entry?.metadata?.participants).toEqual(['snapshot-smoke#0']);
	});

	it('captures and restores a declared host-tree subtree', async () => {
		const observed: {
			captureExit: Exit.Exit<SnapshotMetadata, unknown> | null;
			restoreExit: Exit.Exit<SnapshotMetadata, unknown> | null;
			listExit: Exit.Exit<ReadonlyArray<SnapshotCatalogEntry>, unknown> | null;
			restoredContents: string | null;
			existsAfterDelete: boolean | null;
		} = {
			captureExit: null,
			restoreExit: null,
			listExit: null,
			restoredContents: null,
			existsAfterDelete: null,
		};

		const result = await runBoot({
			stack: hostTreeStack,
			appName: 'snapshot-host-tree-e2e',
			stackName: 'main',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const resolved = ctx.resolvedValues.get('snapshot-host-tree#0') as
						| { readonly dir: string; readonly file: string }
						| undefined;
					expect(resolved).toBeDefined();
					if (resolved === undefined) return;

					expect(readFileSync(resolved.file, 'utf8')).toBe('original contents\n');
					observed.captureExit = yield* Effect.exit(ctx.snapshot.capture('host-tree-real'));

					writeFileSync(resolved.file, 'mutated contents\n');
					rmSync(resolved.dir, { recursive: true, force: true });
					observed.existsAfterDelete = existsSync(resolved.file);

					observed.restoreExit = yield* Effect.exit(ctx.snapshot.restore('host-tree-real'));
					observed.restoredContents = readFileSync(resolved.file, 'utf8');
					observed.listExit = yield* Effect.exit(ctx.snapshot.list);
				}),
		});

		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys]).toEqual(['snapshot-host-tree#0']);
		expect(observed.existsAfterDelete).toBe(false);
		expect(observed.restoredContents).toBe('original contents\n');

		const captureExit = observed.captureExit;
		expect(captureExit).not.toBeNull();
		if (captureExit === null) return;
		expect(Exit.isSuccess(captureExit)).toBe(true);
		if (!Exit.isSuccess(captureExit)) return;
		expect(captureExit.value.app).toBe('snapshot-host-tree-e2e');
		expect(captureExit.value.stack).toBe('main');
		expect(captureExit.value.network).toBe('sui:local');
		expect(captureExit.value.hostTreeIncluded).toBe(true);
		expect(captureExit.value.subtrees).toEqual([
			{
				plugin: 'snapshot-host-tree#0',
				relPath: 'snapshot-host-tree',
				missingTolerance: 'fatal',
				secretMaterial: false,
			},
		]);
		expect(Object.keys(captureExit.value.identity)).toEqual(['snapshot-host-tree#0']);
		expect(captureExit.value.identity['snapshot-host-tree#0']).toContain('snapshot-host-tree-e2e');

		const restoreExit = observed.restoreExit;
		expect(restoreExit).not.toBeNull();
		if (restoreExit === null) return;
		expect(Exit.isSuccess(restoreExit)).toBe(true);

		const listExit = observed.listExit;
		expect(listExit).not.toBeNull();
		if (listExit === null) return;
		expect(Exit.isSuccess(listExit)).toBe(true);
		if (!Exit.isSuccess(listExit)) return;
		const entry = listExit.value.find((item) => item.id === 'host-tree-real');
		expect(entry?.metadata?.hostTreeIncluded).toBe(true);
		expect(entry?.metadata?.participants).toEqual(['snapshot-host-tree#0']);
	});
});
