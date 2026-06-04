// `planExcluding` — the live `snapshot.restore` re-acquire must
// drain every chain-stateful plugin but LEAVE plugins that declared
// `keepAliveOnRestore` running, so a restore-initiating transport doesn't
// tear down the connection it is answering on (which surfaced to the UI as
// a 502 despite success). Substrate filters purely on the plugin-declared
// node flag — no plugin-name knowledge.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { definePlugin } from '../../../../src/substrate/plugin.ts';
import { resolveGraph } from '../../../../src/substrate/runtime/lifecycle/dep-graph.ts';
import { planExcluding } from '../../../../src/substrate/runtime/lifecycle/selective-restart.ts';
import { plan } from '../../../../src/substrate/runtime/reconcile/graph.ts';

const svc = (id: string) =>
	definePlugin({
		id,
		role: 'service' as const,
		section: 'service',
		start: () => Effect.succeed({ tag: id }),
	});

/** A plugin that opts out of restore-drain via the substrate-visible flag. */
const keepAliveSvc = (id: string) =>
	definePlugin({
		id,
		role: 'service' as const,
		section: 'service',
		keepAliveOnRestore: true,
		start: () => Effect.succeed({ tag: id }),
	});

describe('resolveGraph keepAliveOnRestore', () => {
	it('stamps the node flag from the plugin decl (default false)', async () => {
		const graph = await Effect.runPromise(
			resolveGraph([svc('alpha'), keepAliveSvc('beta')]),
		);
		const flagById = new Map(
			[...graph.nodes.values()].map((n) => [n.member.id, n.keepAliveOnRestore]),
		);
		expect(flagById.get('alpha')).toBe(false);
		expect(flagById.get('beta')).toBe(true);
	});
});

describe('planExcluding', () => {
	it('drains every plugin but leaves keep-alive transports live', async () => {
		const graph = await Effect.runPromise(
			resolveGraph([
				svc('sui'),
				svc('package'),
				keepAliveSvc('host-service/app'),
				keepAliveSvc('dashboard'),
			]),
		);

		const full = plan(graph, { kind: 'graph-keys', keys: [...graph.nodes.keys()] }, 'drain');
		const partial = planExcluding(graph, (node) => node.keepAliveOnRestore);

		expect(full.slice.size).toBe(graph.nodes.size);
		const keptIds = [...partial.slice].map((k) => String(k).split('#', 1)[0]).sort();
		expect(keptIds).toEqual(['package', 'sui']);
		// teardown/acquire orders cover exactly the (reduced) slice.
		expect(new Set(partial.teardownOrder)).toEqual(partial.slice);
		expect(new Set(partial.acquireOrder)).toEqual(partial.slice);
	});

	it('drains everything when no plugin opts out', async () => {
		const graph = await Effect.runPromise(resolveGraph([svc('sui'), svc('package')]));
		const partial = planExcluding(graph, (node) => node.keepAliveOnRestore);
		expect(partial.slice.size).toBe(graph.nodes.size);
	});
});
