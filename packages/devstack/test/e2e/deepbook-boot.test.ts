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
});
