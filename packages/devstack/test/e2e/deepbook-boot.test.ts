// DeepBook composition smoke tests.
//
// These are intentionally not docker-driven boots. They pin the public
// composition contract for all supported modes so dependsOn ordering and
// mode-narrowing drift surface before app-level e2e tests run.

import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { account } from '../../src/plugins/account/index.ts';
import { deepbook } from '../../src/plugins/deepbook/index.ts';
import { localPackage } from '../../src/plugins/package/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';

const override = {
	mode: 'override',
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
} as const;

const deepbookPackageFor = (publisher: ReturnType<typeof account>) =>
	localPackage('deepbook_pkg', {
		sourcePath: 'move/deepbook',
		publisher,
		capture: {
			registryId: '::registry::Registry',
			adminCapId: '::registry::DeepbookAdminCap',
		},
	});

describe('deepbook + sui.local() composes via defineDevstack', () => {
	it('override mode composes with explicit deployment ids', () => {
		const suiPlugin = sui();
		const dex = deepbook({ ...override, name: 'main' });

		const stack = defineDevstack({
			members: [suiPlugin, dex],
			stackName: 'deepbook-smoke',
		});
		expect(stack._tag).toBe('Stack');
		expect(readStackEngine(stack).members.length).toBe(2);
		const ids = readStackEngine(stack).members.map((m) => m.id);
		expect(ids).toContain('sui');
		expect(ids).toContain('deepbook/main');
	});

	it('override mode depends on sui only', () => {
		const dex = deepbook({
			...override,
			name: 'arena',
		});
		expect(dex.id).toBe('deepbook/arena');
		expect(dex.role).toBe('task');
		expect(dex.dependsOn.map((resource) => resource.id)).toEqual(['sui']);
	});

	it('local mode composes with publisher and package refs', () => {
		const suiPlugin = sui();
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const dex = deepbook({
			mode: 'local',
			publisher,
			package: deepbookPackage,
			pools: [] as const,
			name: 'main',
		});

		const stack = defineDevstack({
			members: [suiPlugin, publisher, deepbookPackage, dex],
			stackName: 'deepbook-smoke',
		});
		expect(stack._tag).toBe('Stack');
		expect(readStackEngine(stack).members.length).toBe(4);
		const ids = readStackEngine(stack).members.map((m) => m.id);
		expect(ids).toContain('sui');
		expect(ids).toContain('account/publisher');
		expect(ids).toContain('package:deepbook_pkg');
		expect(ids).toContain('deepbook/main');
	});

	it('local mode threads the publisher account ref through dependencies', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const dex = deepbook({
			mode: 'local',
			publisher,
			package: deepbookPackage,
			pools: [] as const,
			name: 'arena',
		});
		expect(dex.id).toBe('deepbook/arena');
		expect(dex.role).toBe('task');
		expect(dex.dependsOn.map((resource) => resource.id)).toEqual([
			'sui',
			'account/publisher',
			'package:deepbook_pkg',
		]);
	});

	it('known mode wraps a canonical deployment', () => {
		const suiPlugin = sui();
		const dex = deepbook({
			mode: 'known',
			packageId: '0xpkg',
			registryId: '0xreg',
			chain: 'sui:testnet',
			name: 'live',
		});
		const stack = defineDevstack({ members: [suiPlugin, dex], stackName: 'deepbook-known-smoke' });
		const ids = readStackEngine(stack).members.map((m) => m.id);
		expect(ids).toEqual(expect.arrayContaining(['sui', 'deepbook/live']));
	});

	it('default name is `deepbook` when no name is supplied', () => {
		const dex = deepbook(override);
		expect(dex.id).toBe('deepbook/deepbook');
	});

	it('declares a stable plugin metadata key', () => {
		const dex = deepbook({ ...override, name: 'main' });
		expect(String(dex.pluginKey)).toBe('deepbook:main');
	});

	it('no-arg deepbook() synthesizes the bundled publisher / package / pool closure', () => {
		const suiPlugin = sui();
		const dex = deepbook();

		const stack = defineDevstack({
			members: [suiPlugin, dex],
			stackName: 'deepbook-oneliner-smoke',
		});
		const ids = readStackEngine(stack).members.map((m) => m.id);
		// Bundled publisher + DeepBook/Pyth packages + DEEP coin are pulled
		// into the stack closure by the synthesized `dependsOn`, even though
		// the app only listed `sui()` + `deepbook()`.
		expect(ids).toEqual(
			expect.arrayContaining([
				'sui',
				'deepbook/deepbook',
				'account/deepbook_publisher',
				'account/deepbook_pyth_publisher',
				'package:deepbook',
				'package:pyth',
				'coin:deepbook/deep',
			]),
		);
		// No duplicate members in the closure.
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('deepbook({ mode: "local" }) with no package synthesizes the same closure', () => {
		const dex = deepbook({ mode: 'local' });
		expect(dex.id).toBe('deepbook/deepbook');
		// Runtime `dependsOn` carries the synthesized members so the stack
		// closure pulls them in. (The STATIC type is narrowed to `[sui]`; that
		// is a type-only concern asserted by the no-arg closure test above.)
		const depIds = dex.dependsOn.map((resource) => resource.id);
		expect(depIds).toEqual(
			expect.arrayContaining(['sui', 'account/deepbook_publisher', 'package:deepbook']),
		);
	});

	it('a synthesized instance can be named without colliding', () => {
		const dex = deepbook({ mode: 'local', name: 'arena' });
		const stack = defineDevstack({ members: [sui(), dex], stackName: 'deepbook-named-smoke' });
		const ids = readStackEngine(stack).members.map((m) => m.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'deepbook/arena',
				'account/deepbook_arena_publisher',
				'package:deepbook_arena',
				'package:pyth_arena',
			]),
		);
	});

	it('partial override (explicit package+publisher, omitted pools) does not fabricate a hidden package or pyth', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		// `pools` OMITTED on purpose — synthesis must fill ONLY the default pool,
		// relative to the EXPLICIT package, and must NOT publish a second hidden
		// `package:deepbook` / hidden pyth that would duplicate-provider or
		// phantom-member the closure.
		const dex = deepbook({ mode: 'local', publisher, package: deepbookPackage });

		const stack = defineDevstack({
			members: [sui(), publisher, deepbookPackage, dex],
			stackName: 'deepbook-partial-override',
		});
		const ids = readStackEngine(stack).members.map((m) => m.id);

		// No duplicate providers in the resolved closure.
		expect(new Set(ids).size).toBe(ids.length);
		// The caller's explicit package is used; no hidden `package:deepbook`.
		expect(ids).toContain('package:deepbook_pkg');
		expect(ids).not.toContain('package:deepbook');
		// The default pool's DEEP coin is derived from the EXPLICIT package, so
		// its coin ref is `coin:deepbook_pkg/deep`, NOT a hidden-package coin.
		expect(ids).toContain('coin:deepbook_pkg/deep');
		// A pyth sandbox is still synthesized (caller gave none), pinned to this
		// instance's suffix — exactly one pyth package.
		expect(ids.filter((id) => id.startsWith('package:pyth')).length).toBe(1);
		expect(ids).toContain('package:pyth');
	});

	it('partial override threads the explicit-package DEEP coin into deepbook dependencies', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const dex = deepbook({ mode: 'local', publisher, package: deepbookPackage });
		const depIds = dex.dependsOn.map((resource) => resource.id);
		// sui + explicit publisher + explicit package + synthesized pyth (pusher +
		// package) + the default pool's explicit-package DEEP coin (+ builtin SUI).
		expect(depIds).toContain('sui');
		expect(depIds).toContain('account/publisher');
		expect(depIds).toContain('package:deepbook_pkg');
		expect(depIds).toContain('coin:deepbook_pkg/deep');
		// No phantom hidden-package coin / duplicate package provider.
		expect(depIds).not.toContain('coin:deepbook/deep');
		expect(new Set(depIds).size).toBe(depIds.length);
	});

	it('two synthesized instances whose names differ only by a sanitized char get distinct member ids', () => {
		// `foo-bar` and `foo_bar` both sanitize to `foo_bar`; a naive
		// `replace(/[^A-Za-z0-9_]/g,'_')` suffix would collapse them onto the
		// same `deepbook_foo_bar_publisher` / `package:deepbook_foo_bar` ids and
		// trip a duplicate-provider error in `defineDevstack`. A stable-hash
		// suffix keeps the synthesized member ids distinct. (We assert on the
		// per-instance `dependsOn` ids directly rather than composing both into
		// one stack — two synthesized default pools also share the builtin
		// `coin:sui`, an unrelated legitimate single-provider constraint.)
		const hyphen = deepbook({ mode: 'local', name: 'foo-bar' });
		const underscore = deepbook({ mode: 'local', name: 'foo_bar' });

		const synthIds = (dex: typeof hyphen) =>
			dex.dependsOn
				.map((resource) => resource.id)
				.filter(
					(id) =>
						id.startsWith('account/') ||
						(id.startsWith('package:') && String(id) !== 'package:sui'),
				);

		const hyphenIds = synthIds(hyphen);
		const underscoreIds = synthIds(underscore);

		// The already-valid `foo_bar` keeps the clean, readable suffix...
		expect(underscoreIds).toContain('account/deepbook_foo_bar_publisher');
		expect(underscoreIds).toContain('package:deepbook_foo_bar');
		// ...while `foo-bar` (which sanitation rewrote) gets a hash-disambiguated
		// suffix, so it does NOT collide on the clean `foo_bar` id.
		expect(hyphenIds).not.toContain('account/deepbook_foo_bar_publisher');
		expect(hyphenIds).not.toContain('package:deepbook_foo_bar');
		// The two instances produce DISJOINT synthesized id sets — no member id
		// is shared between `foo-bar` and `foo_bar` (the collision the fix
		// prevents).
		const overlap = hyphenIds.filter((id) => underscoreIds.includes(id));
		expect(overlap).toEqual([]);

		// The deepbook resource ids themselves stay distinct (raw, unsanitized).
		expect(hyphen.id).toBe('deepbook/foo-bar');
		expect(underscore.id).toBe('deepbook/foo_bar');
	});
});
