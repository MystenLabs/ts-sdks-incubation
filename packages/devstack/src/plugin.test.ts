import { describe, expect, it } from 'vitest';
import type { Action, Plugin, Provides } from './core/types.js';
import { defineDevstackConfig, definePlugin, expandPluginActions } from './plugin.js';

const action = (name: string, opts: { needs?: string[]; provides?: Provides } = {}): Action =>
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

	it("rejects names ending in '-setup' (reserved for the synthesizer)", () => {
		// `defineDevstackConfig` builds a synthetic `<app>-setup` plugin
		// from inline use:[] actions; user-defined plugins ending in
		// `-setup` would collide and surface as a vague duplicate-action
		// error at topo time. Reject up front.
		expect(() => definePlugin({ name: 'wallet-setup', actions: () => [] })).toThrow(
			/'-setup' — that suffix is reserved/,
		);
		expect(() => definePlugin({ name: 'foo-setup', actions: () => [] })).toThrow(
			/'-setup' — that suffix is reserved/,
		);
	});

	it("accepts names that contain 'setup' but don't end in '-setup'", () => {
		// `setup-helper`, `mysetup`, `wallet-setup-extra` are fine.
		expect(() => definePlugin({ name: 'setup-helper', actions: () => [] })).not.toThrow();
		expect(() => definePlugin({ name: 'mysetup', actions: () => [] })).not.toThrow();
		expect(() => definePlugin({ name: 'wallet-setup-extra', actions: () => [] })).not.toThrow();
	});
});

describe('expandPluginActions — synthesizer plugin name acceptance', () => {
	// `defineDevstackConfig` constructs a synthetic plugin object directly
	// (not via `definePlugin`) named `<app>-setup` and stamps it with a
	// module-private symbol so `expandPluginActions` lets the synthesizer
	// brand past the reserved-suffix gate. Third-party plugins reaching
	// the same path (skipping `definePlugin`) without the brand are
	// rejected.
	it("rejects an unbranded '<app>-setup' Plugin literal from a third party", () => {
		// A naïve third party could skip `definePlugin`'s strict check and
		// build the Plugin object literal directly — without the brand,
		// `expandPluginActions` rejects.
		expect(() =>
			expandPluginActions([{ name: 'foo-setup', actions: () => [action('a')] }]),
		).toThrow(/'-setup' — that suffix is reserved/);
		expect(() =>
			expandPluginActions([{ name: 'bar-setup', actions: () => [] }]),
		).toThrow(/'-setup' — that suffix is reserved/);
	});

	it("rejects a third-party plugin that fakes the marker with a different symbol", () => {
		// Symbol identity matters: an own-named symbol with the same
		// description doesn't match the module-private symbol used by
		// the synthesizer, so the bypass attempt fails closed.
		const fakeBrand = Symbol('devstack.synthesized-plugin');
		const fake = { name: 'evil-setup', actions: () => [action('a')] } as unknown as Record<
			symbol,
			unknown
		>;
		fake[fakeBrand] = true;
		expect(() => expandPluginActions([fake as unknown as { name: string; actions: () => Action[] }]))
			.toThrow(/'-setup' — that suffix is reserved/);
	});

	it("accepts the branded plugin produced by defineDevstackConfig (round-trip)", () => {
		// Drive the actual synthesis path: configure inline setup actions
		// and run the resulting `<app>-setup` plugin through expand.
		const config = defineDevstackConfig({
			app: 'arena',
			use: [{ name: 'a', type: 'Service' } as Action],
		});
		expect(() => expandPluginActions(config.plugins)).not.toThrow();
		// The synthesizer named the plugin `<app>-setup`.
		expect(config.plugins.some((p) => p.name === 'arena-setup')).toBe(true);
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
			plugin('arena', [action('connect_four', { needs: ['accounts.fund'] })]),
		]);
		const cf = out.find((a) => a.name === 'arena.connect_four');
		expect(cf?.needs).toEqual(['accounts.fund']);
	});

	it('passes through capability `:before` queries unchanged', () => {
		const out = expandPluginActions([
			plugin('walrus', [
				action('network', { provides: { capabilities: ['walrus.app-network'] } }),
				action('localnet', { needs: ['walrus.app-network:before'] }),
			]),
			plugin('arena', [action('connect_four', { needs: ['db.cluster:before', 'accounts.fund'] })]),
		]);
		const localnet = out.find((a) => a.name === 'walrus.localnet');
		expect(localnet?.needs).toEqual(['walrus.app-network:before']);
		const cf = out.find((a) => a.name === 'arena.connect_four');
		expect(cf?.needs).toEqual(['db.cluster:before', 'accounts.fund']);
	});

	it('throws when an object-form provides has un-namespaced capabilities', () => {
		expect(() =>
			expandPluginActions([
				plugin('walrus', [action('network', { provides: { capabilities: ['app-network'] } })]),
			]),
		).toThrow(/walrus.*declared capability 'app-network' without its own namespace/);
	});

	it('accepts object-form provides with namespaced capabilities and a registry hook', () => {
		const hook = async () => {};
		const out = expandPluginActions([
			plugin('walrus', [
				action('network', {
					provides: { capabilities: ['walrus.app-network'], registry: hook },
				}),
			]),
		]);
		const network = out.find((a) => a.name === 'walrus.network');
		expect(network?.provides).toEqual({
			capabilities: ['walrus.app-network'],
			registry: hook,
		});
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

describe('expandPluginActions — provides cross-validation', () => {
	it('passes when the declared provides set matches the actions returned', () => {
		expect(() =>
			expandPluginActions([
				{
					name: 'x',
					provides: ['x.service', 'x.build'],
					actions: () => [action('service'), action('build')],
				},
			]),
		).not.toThrow();
	});

	it("throws when provides declares a name that no action returns (typo: 'x.servic' vs 'x.service')", () => {
		expect(() =>
			expandPluginActions([
				{
					name: 'x',
					provides: ['x.servic'],
					actions: () => [action('service')],
				},
			]),
		).toThrow(/declared provides include 'x\.servic'/);
	});

	it('throws when an action is returned but not listed in provides', () => {
		expect(() =>
			expandPluginActions([
				{
					name: 'x',
					provides: ['x.service'],
					actions: () => [action('service'), action('extra')],
				},
			]),
		).toThrow(/returned action 'x\.extra' but it isn't listed/);
	});

	it("skips the cross-check when provides is undefined (dynamic-action plugins like walrus.node-${number})", () => {
		expect(() =>
			expandPluginActions([
				{
					name: 'dyn',
					actions: () => [action('node-0'), action('node-1')],
				},
			]),
		).not.toThrow();
	});
});
