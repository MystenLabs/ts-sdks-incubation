// Unit tests for the substrate-owned plugin-expander contract.
//
// Plugin-author symmetry: ANY plugin can attach the well-known
// expander symbol and have the composer rewrite its placeholder
// member with the resolved one. Wallet is the built-in adopter; this
// test exercises the contract through a custom plugin to pin the
// "no privileges built-ins have that customs cannot replicate" rule.

import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { definePlugin, resource } from '../../src/api/define-plugin.ts';
import {
	PLUGIN_EXPANDER,
	attachPluginExpander,
	isPluginExpanderPair,
	readPluginExpander,
	runPluginExpanders,
} from '../../src/contracts/plugin-expander.ts';
import { Effect } from 'effect';

describe('PLUGIN_EXPANDER — substrate-owned compose-time hook', () => {
	it('exposes a globally-registered symbol so any plugin can attach without importing each other', () => {
		expect(typeof PLUGIN_EXPANDER).toBe('symbol');
		// Confirms the Symbol.for path — re-resolving the same key yields
		// the same identity (the property that lets plugin authors attach
		// without a direct module dep on this file).
		expect(PLUGIN_EXPANDER).toBe(Symbol.for('@devstack/contracts/plugin-expander'));
	});

	it('attachPluginExpander writes the hook as a value-only property (not on the TS return type)', () => {
		const fooResource = resource<'foo', { ok: true }>('foo');
		const placeholder = definePlugin({
			id: fooResource.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		expect(readPluginExpander(placeholder)).toBeUndefined();

		attachPluginExpander(placeholder, () => placeholder);
		expect(typeof readPluginExpander(placeholder)).toBe('function');
	});

	it('runPluginExpanders returns the input verbatim when no member carries a hook (zero-alloc fast path)', () => {
		const a = resource<'a', { ok: true }>('a');
		const b = resource<'b', { ok: true }>('b');
		const aPlugin = definePlugin({
			id: a.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		const bPlugin = definePlugin({
			id: b.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		const members = [aPlugin, bPlugin] as const;
		expect(runPluginExpanders(members)).toBe(members);
	});

	it('runPluginExpanders substitutes placeholders for the expander result, leaving non-hooked members untouched', () => {
		const a = resource<'a', { ok: true }>('a');
		const b = resource<'b', { ok: true }>('b');
		const aPlugin = definePlugin({
			id: a.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		const placeholder = definePlugin({
			id: b.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		const realB = definePlugin({
			id: b.id,
			dependsOn: [a],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		let receivedMembers: ReadonlyArray<unknown> = [];
		attachPluginExpander(placeholder, (members) => {
			receivedMembers = members;
			return realB;
		});

		const expanded = runPluginExpanders([aPlugin, placeholder]);
		expect(expanded[0]).toBe(aPlugin);
		expect(expanded[1]).toBe(realB);
		// The expander sees the FULL composed member tuple, not a filtered
		// slice — domain-specific filtering is the plugin's job.
		expect(receivedMembers).toHaveLength(2);
	});

	it('isPluginExpanderPair lets the composer accept placeholder + expanded-form duplicates with the same id', () => {
		const a = resource<'a', { ok: true }>('a');
		const placeholder = definePlugin({
			id: a.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		const real = definePlugin({
			id: a.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		attachPluginExpander(placeholder, () => real);
		expect(isPluginExpanderPair(placeholder, real)).toBe(true);

		const unrelated = definePlugin({
			id: resource<'b', { ok: true }>('b').id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		expect(isPluginExpanderPair(placeholder, unrelated)).toBe(false);
	});

	it('a custom plugin attaching the expander symbol is rewritten by defineDevstack with no composer special-case', () => {
		// Build a sibling resource the custom plugin will discover and
		// fold into its dependencies at compose time.
		const sibling = resource<'custom-sibling', { ok: true }>('custom-sibling');
		const siblingPlugin = definePlugin({
			id: sibling.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});

		// The custom "expander-driven" plugin's id.
		const driven = resource<'custom-driven', { ok: true }>('custom-driven');
		const placeholder = definePlugin({
			id: driven.id,
			dependsOn: [],
			role: 'task',
			start: () => Effect.succeed({ ok: true }),
		});
		attachPluginExpander(placeholder, (members) => {
			// Filter to siblings the plugin cares about — by id-prefix in
			// this contrived case.
			const matching = members.filter((m) => m.id.startsWith('custom-sibling'));
			return definePlugin({
				id: driven.id,
				dependsOn: matching,
				role: 'task',
				start: () => Effect.succeed({ ok: true }),
			});
		});

		const stack = defineDevstack({ members: [siblingPlugin, placeholder] });
		const drivenMember = readStackEngine(stack).members.find((m) => m.id === 'custom-driven');
		expect(drivenMember).toBeDefined();
		// The placeholder's compile-time `dependsOn: []` becomes `dependsOn: matching`
		// at runtime through the expander; project through `unknown` to read it.
		const runtimeDeps = drivenMember!.dependsOn as unknown as ReadonlyArray<{
			readonly id: string;
		}>;
		expect(runtimeDeps.map((d) => d.id)).toEqual(['custom-sibling']);
		// The composer does NOT special-case this plugin anywhere — the
		// substrate-owned contract is the only seam.
	});
});
