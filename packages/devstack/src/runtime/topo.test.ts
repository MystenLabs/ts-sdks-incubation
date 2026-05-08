import { describe, expect, it } from 'vitest';
import type { Action, Provides } from '../core/types.js';
import { topoSortActions } from './topo.js';

const a = (name: string, opts: { needs?: string[]; provides?: Provides } = {}): Action =>
	({
		name,
		type: 'Service',
		...opts,
	}) as Action;

const indexOf = (sorted: Action[], name: string): number =>
	sorted.findIndex((x) => x.name === name);

describe('topoSortActions — direct needs (unchanged behavior)', () => {
	it('orders by `needs`', () => {
		const sorted = topoSortActions([a('b', { needs: ['a'] }), a('a')]);
		expect(sorted.map((x) => x.name)).toEqual(['a', 'b']);
	});

	it('throws on cycle', () => {
		expect(() => topoSortActions([a('a', { needs: ['b'] }), a('b', { needs: ['a'] })])).toThrow(
			/cycle detected/,
		);
	});

	it('reconstructs the cycle path in the error message', () => {
		// a → b → c → a: each action lists its predecessor in `needs` so the
		// dep edge runs from the listed name back to the action. The cycle
		// reconstructor walks needs-edges, so from `a` we traverse
		// a → b → c → a, closing the loop.
		let captured: string | undefined;
		try {
			topoSortActions([
				a('a', { needs: ['b'] }),
				a('b', { needs: ['c'] }),
				a('c', { needs: ['a'] }),
			]);
		} catch (err) {
			captured = err instanceof Error ? err.message : String(err);
		}
		expect(captured).toBeDefined();
		expect(captured).toMatch(/cycle detected: /);
		// All three names + at least one node repeated to close the loop.
		expect(captured).toMatch(/a/);
		expect(captured).toMatch(/b/);
		expect(captured).toMatch(/c/);
		// Every cycle has the form "X → Y → Z → X" — the starting node
		// repeats. Verify the path-arrow separator is present.
		expect(captured).toMatch(/ → /);
		// Verify the round-trip: count the first cycle node in the
		// detail; it must appear at least twice (head and tail).
		const detail = captured?.match(/cycle detected: (.+)$/)?.[1] ?? '';
		const head = detail.split(' → ')[0];
		expect(head).toBeDefined();
		expect(detail.endsWith(` → ${head}`)).toBe(true);
	});

	it('throws on unknown direct dep', () => {
		expect(() => topoSortActions([a('a', { needs: ['ghost'] })])).toThrow(/needs unknown/);
	});

	it('suggests a near-match for an unknown dep with a small typo', () => {
		// Off-by-one typo: missing trailing 'r' on 'connect_four'. The
		// suggester reports the close candidate inline so the user sees
		// the fix without rerunning a separate `actions list`.
		let captured: string | undefined;
		try {
			topoSortActions([
				a('arena.connect_four'),
				a('arena.lobby', { needs: ['arena.connect_fou'] }),
			]);
		} catch (err) {
			captured = err instanceof Error ? err.message : String(err);
		}
		expect(captured).toBeDefined();
		expect(captured).toMatch(/needs unknown 'arena\.connect_fou'/);
		expect(captured).toMatch(/did you mean: 'arena\.connect_four'/);
	});

	it('omits the suggestion when no candidate is within edit-distance limit', () => {
		// A wildly different name shouldn't get a noisy suggestion. The
		// budget scales with the unknown's length.
		let captured: string | undefined;
		try {
			topoSortActions([
				a('arena.connect_four'),
				a('arena.lobby', { needs: ['totally.unrelated.action'] }),
			]);
		} catch (err) {
			captured = err instanceof Error ? err.message : String(err);
		}
		expect(captured).toBeDefined();
		expect(captured).toMatch(/needs unknown/);
		expect(captured).not.toMatch(/did you mean/);
	});

	it('throws on duplicate name', () => {
		expect(() => topoSortActions([a('a'), a('a')])).toThrow(/duplicate action name/);
	});
});

describe('topoSortActions — capability `:before` queries', () => {
	it('rewrites `cap:before` into a needs edge on each provider', () => {
		const sorted = topoSortActions([
			a('me', { needs: ['net:before'] }),
			a('p', { provides: { capabilities: ['net'] } }),
		]);
		expect(indexOf(sorted, 'p')).toBeLessThan(indexOf(sorted, 'me'));
		const meAfter = sorted.find((x) => x.name === 'me');
		expect(meAfter?.needs).toEqual(['p']);
	});

	it('orders me after every provider when a capability has multiple', () => {
		const sorted = topoSortActions([
			a('me', { needs: ['net:before'] }),
			a('p1', { provides: { capabilities: ['net'] } }),
			a('p2', { provides: { capabilities: ['net'] } }),
		]);
		expect(indexOf(sorted, 'p1')).toBeLessThan(indexOf(sorted, 'me'));
		expect(indexOf(sorted, 'p2')).toBeLessThan(indexOf(sorted, 'me'));
	});

	it('silently drops `cap:before` queries with no providers', () => {
		const sorted = topoSortActions([a('me', { needs: ['ghostcap:before'] })]);
		expect(sorted.map((x) => x.name)).toEqual(['me']);
		expect(sorted[0]?.needs).toEqual([]);
	});

	it('drops a self-edge when an action provides and queries the same capability', () => {
		const sorted = topoSortActions([a('me', { needs: ['net:before'], provides: { capabilities: ['net'] } })]);
		expect(sorted.map((x) => x.name)).toEqual(['me']);
		expect(sorted[0]?.needs).toEqual([]);
	});

	it('does not affect direct (non-suffixed) deps when both forms appear', () => {
		const sorted = topoSortActions([
			a('me', { needs: ['hardDep', 'net:before'] }),
			a('hardDep'),
			a('p', { provides: { capabilities: ['net'] } }),
		]);
		expect(indexOf(sorted, 'hardDep')).toBeLessThan(indexOf(sorted, 'me'));
		expect(indexOf(sorted, 'p')).toBeLessThan(indexOf(sorted, 'me'));
	});
});

describe('topoSortActions — `:after` removal', () => {
	it('throws when an action still uses the removed `:after` suffix', () => {
		expect(() =>
			topoSortActions([
				a('me', { needs: ['net:after'] }),
				a('p', { provides: { capabilities: ['net'] } }),
			]),
		).toThrow(/dropped .:after.*Use .:before/s);
	});
});

describe('topoSortActions — walrus migration', () => {
	it('orders walrus.network before sui.localnet via `app-network` capability', () => {
		const sorted = topoSortActions([
			a('sui.localnet', { needs: ['walrus.app-network:before'] }),
			a('walrus.network', { provides: { capabilities: ['walrus.app-network'] } }),
		]);
		expect(indexOf(sorted, 'walrus.network')).toBeLessThan(indexOf(sorted, 'sui.localnet'));
	});

	it('falls back gracefully when walrus.network is not loaded (sui-only stack)', () => {
		const sorted = topoSortActions([a('sui.localnet', { needs: ['walrus.app-network:before'] })]);
		expect(sorted.map((x) => x.name)).toEqual(['sui.localnet']);
		expect(sorted[0]?.needs).toEqual([]);
	});
});
