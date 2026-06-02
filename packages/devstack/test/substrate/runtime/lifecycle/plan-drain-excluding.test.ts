// `planFullDrainExcluding` / `isNonRestorableTransport` — the live
// `snapshot.restore` re-acquire must drain every chain-stateful plugin
// but LEAVE the operator transport (dashboard + host-service) running, so
// a dashboard-initiated restore doesn't tear down the connection it is
// answering on (which surfaced to the UI as a 502 despite success).

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../../src/substrate/brand.ts';
import { definePlugin } from '../../../../src/substrate/plugin.ts';
import { resolveGraph } from '../../../../src/substrate/runtime/lifecycle/dep-graph.ts';
import {
	isNonRestorableTransport,
	planFullDrain,
	planFullDrainExcluding,
} from '../../../../src/substrate/runtime/lifecycle/selective-restart.ts';

const svc = (id: string) =>
	definePlugin({ id, role: 'service' as const, section: 'service', start: () => Effect.succeed({ tag: id }) });

describe('isNonRestorableTransport', () => {
	it('matches dashboard + host-service ids on ordinal-suffixed keys', () => {
		expect(isNonRestorableTransport(pluginKey('dashboard#8'))).toBe(true);
		expect(isNonRestorableTransport(pluginKey('host-service/app#7'))).toBe(true);
	});

	it('does NOT match chain-stateful plugins (drain when in doubt)', () => {
		for (const k of ['sui#0', 'account/alice#1', 'package#3', 'action#4', 'seal#5', 'walrus#6', 'deepbook#7', 'coin/usdc#8', 'wallet#9']) {
			expect(isNonRestorableTransport(pluginKey(k))).toBe(false);
		}
	});
});

describe('planFullDrainExcluding', () => {
	it('drains every chain plugin but leaves dashboard + host-service live', async () => {
		const graph = await Effect.runPromise(
			resolveGraph([svc('sui'), svc('package'), svc('host-service/app'), svc('dashboard')]),
		);

		const full = planFullDrain(graph);
		const partial = planFullDrainExcluding(graph, isNonRestorableTransport);

		expect(full.slice.size).toBe(graph.nodes.size);
		const keptIds = [...partial.slice].map((k) => String(k).split('#', 1)[0]).sort();
		expect(keptIds).toEqual(['package', 'sui']);
		// teardown/acquire orders cover exactly the (reduced) slice.
		expect(new Set(partial.teardownOrder)).toEqual(partial.slice);
		expect(new Set(partial.acquireOrder)).toEqual(partial.slice);
	});
});
