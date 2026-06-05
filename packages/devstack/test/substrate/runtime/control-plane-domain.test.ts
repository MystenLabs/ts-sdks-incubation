import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { definePlugin, staticInputIdentity } from '../../../src/api/define-plugin.ts';
import { buildControlPlaneDomain } from '../../../src/substrate/runtime/control-plane/domain.ts';
import type { PluginRegistry } from '../../../src/substrate/runtime/lifecycle/index.ts';
import { resolveGraph } from '../../../src/substrate/runtime/lifecycle/index.ts';
import {
	SNAPSHOT_GRAPH_INPUT_VERSION,
	type SnapshotCatalogEntry,
	type SnapshotOrchestrator,
} from '../../../src/orchestrators/snapshot/index.ts';

const registry = { entries: new Map() } as unknown as PluginRegistry;

const testPlugin = definePlugin({
	id: 'test/node',
	role: 'service',
	section: 'service',
	inputIdentity: staticInputIdentity({ value: 'current' }),
	start: () => Effect.succeed({}),
});

describe('control-plane snapshot domain', () => {
	it.effect('marks snapshots stale when graph input ids differ', () =>
		Effect.gen(function* () {
			const graph = yield* resolveGraph([testPlugin]).pipe(Effect.orDie);
			const snapshot: Pick<SnapshotOrchestrator, 'list'> = {
				list: Effect.succeed([
					{
						id: 'baseline',
						directory: '/snapshots/baseline',
						metadata: {
							id: 'baseline',
							label: 'baseline',
							createdAt: 1,
							app: 'app',
							stack: 'main',
							network: 'sui:local',
							graphInput: {
								version: SNAPSHOT_GRAPH_INPUT_VERSION,
								graphInputId: 'old-graph',
								nodes: [],
							},
							participants: [],
							containers: [],
							subtrees: [],
							corrupt: false,
						},
					} as unknown as SnapshotCatalogEntry,
				]),
			};
			const domain = buildControlPlaneDomain({
				graph,
				stackOptions: {},
				devstackVersion: '1.0.0',
				registry,
				snapshotOrchestrator: snapshot as SnapshotOrchestrator,
				fileSystem: yield* FileSystem.FileSystem,
				logStore: null,
			});

			const entries = yield* domain.snapshots;
			expect(entries[0]?.graphInputStatus).toBe('stale');
			expect(entries[0]?.snapshotGraphInputId).toBe('old-graph');
			expect(entries[0]?.currentGraphInputId).toMatch(/^[a-f0-9]{64}$/);
			expect(entries[0]?.graphInputWarning).toContain('does not match');
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
