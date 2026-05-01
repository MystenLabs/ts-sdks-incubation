import { describe, expect, it, vi } from 'vitest';
import type { Action, Plugin } from './core/types.js';
import { definePlugin, expandPluginActions } from './plugin.js';

const action = (name: string, opts: { needs?: string[]; provides?: string[] } = {}): Action =>
	({
		name,
		type: 'Service',
		...opts,
	}) as Action;

const plugin = (name: string, actions: Action[]): Plugin => ({
	name,
	actions: () => actions,
});

describe('definePlugin — name validation', () => {
	it('accepts simple lowercase names', () => {
		expect(() => definePlugin({ name: 'sui', actions: () => [] })).not.toThrow();
		expect(() => definePlugin({ name: 'walrus', actions: () => [] })).not.toThrow();
	});

	it('accepts kebab-case and snake_case', () => {
		expect(() => definePlugin({ name: 'token-studio', actions: () => [] })).not.toThrow();
		expect(() => definePlugin({ name: 'private_content', actions: () => [] })).not.toThrow();
	});

	it('rejects camelCase / uppercase letters', () => {
		expect(() => definePlugin({ name: 'tokenStudio', actions: () => [] })).toThrow(
			/invalid plugin name/i,
		);
		expect(() => definePlugin({ name: 'Foo', actions: () => [] })).toThrow(/invalid plugin name/i);
	});

	it('rejects names containing dots (reserved as namespace separator)', () => {
		expect(() => definePlugin({ name: 'foo.bar', actions: () => [] })).toThrow(
			/invalid plugin name/i,
		);
	});

	it('rejects empty names', () => {
		expect(() => definePlugin({ name: '', actions: () => [] })).toThrow(/invalid plugin name/i);
	});

	it('rejects leading-digit names', () => {
		expect(() => definePlugin({ name: '1foo', actions: () => [] })).toThrow(/invalid plugin name/i);
	});

	it('rejects names with whitespace or special chars', () => {
		expect(() => definePlugin({ name: 'foo bar', actions: () => [] })).toThrow(
			/invalid plugin name/i,
		);
		expect(() => definePlugin({ name: 'foo!', actions: () => [] })).toThrow(/invalid plugin name/i);
	});
});

describe('expandPluginActions — auto-prefix', () => {
	it('prefixes bare action names with the plugin namespace', () => {
		const out = expandPluginActions([plugin('arena', [action('connect_four'), action('lobby')])]);
		expect(out.map((a) => a.name)).toEqual(['arena.connect_four', 'arena.lobby']);
	});

	it('passes through dotted names that already match the plugin namespace', () => {
		// Old contract: plugin authors used `scope('foo')` which produced
		// `'plugin.foo'`. Those keep working.
		const out = expandPluginActions([plugin('arena', [action('arena.connect_four')])]);
		expect(out.map((a) => a.name)).toEqual(['arena.connect_four']);
	});

	it('rejects dotted names with a foreign namespace prefix', () => {
		expect(() => expandPluginActions([plugin('arena', [action('sui.localnet')])])).toThrow(
			/dotted name outside its own namespace/,
		);
	});

	it('rejects duplicate action names within a plugin', () => {
		expect(() => expandPluginActions([plugin('arena', [action('a'), action('a')])])).toThrow(
			/duplicate action 'arena\.a'/,
		);
	});
});

describe('expandPluginActions — needs resolution', () => {
	it('resolves bare local needs to the plugin-prefixed form', () => {
		const out = expandPluginActions([
			plugin('arena', [action('connect_four'), action('lobby', { needs: ['connect_four'] })]),
		]);
		const lobby = out.find((a) => a.name === 'arena.lobby');
		expect(lobby?.needs).toEqual(['arena.connect_four']);
	});

	it('throws on bare needs that point at unknown local actions', () => {
		expect(() =>
			expandPluginActions([plugin('arena', [action('lobby', { needs: ['ghost'] })])]),
		).toThrow(/bare need 'ghost' but no local action/);
	});

	it('passes through fully-qualified cross-plugin needs unchanged', () => {
		const out = expandPluginActions([
			plugin('arena', [action('connect_four', { needs: ['sui.accounts'] })]),
		]);
		const cf = out.find((a) => a.name === 'arena.connect_four');
		expect(cf?.needs).toEqual(['sui.accounts']);
	});

	it('passes through capability `:before` / `:after` queries unchanged', () => {
		const out = expandPluginActions([
			plugin('walrus', [
				action('network', { provides: ['walrus.app-network'] }),
				action('localnet', { needs: ['walrus.app-network:before'] }),
			]),
			plugin('arena', [action('connect_four', { needs: ['db.cluster:after', 'sui.accounts'] })]),
		]);
		const localnet = out.find((a) => a.name === 'walrus.localnet');
		expect(localnet?.needs).toEqual(['walrus.app-network:before']);
		const cf = out.find((a) => a.name === 'arena.connect_four');
		expect(cf?.needs).toEqual(['db.cluster:after', 'sui.accounts']);
	});

	it('warns when a plugin declares an un-namespaced capability', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expandPluginActions([plugin('walrus', [action('network', { provides: ['app-network'] })])]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/walrus.*declared capability 'app-network' without its own namespace/),
		);
		warn.mockRestore();
	});

	it('treats local-bare AND fully-qualified self-references identically', () => {
		// Bare 'a' in plugin foo resolves to 'foo.a', same FQN as the
		// dotted form. Authors using either style get the same edge.
		const out = expandPluginActions([
			plugin('foo', [
				action('a'),
				action('b', { needs: ['a'] }),
				action('c', { needs: ['foo.a'] }),
			]),
		]);
		expect(out.find((a) => a.name === 'foo.b')?.needs).toEqual(['foo.a']);
		expect(out.find((a) => a.name === 'foo.c')?.needs).toEqual(['foo.a']);
	});
});

describe('expandPluginActions — own-namespace dotted names accepted', () => {
	it('accepts dotted names that already match the plugin namespace', () => {
		// Useful when migrating action names piecemeal — `'walrus.network'`
		// declared explicitly resolves identically to bare `'network'`.
		const out = expandPluginActions([
			{
				name: 'walrus',
				actions: () => [
					action('walrus.network', { needs: ['walrus.build'] }),
					action('walrus.build'),
				],
			},
		]);
		expect(out.map((a) => a.name).sort()).toEqual(['walrus.build', 'walrus.network']);
		expect(out.find((a) => a.name === 'walrus.network')?.needs).toEqual(['walrus.build']);
	});
});
