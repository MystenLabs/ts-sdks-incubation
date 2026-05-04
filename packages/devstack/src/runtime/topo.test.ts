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

	it('throws on unknown direct dep', () => {
		expect(() => topoSortActions([a('a', { needs: ['ghost'] })])).toThrow(/needs unknown/);
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
