// Deepbook override-mode plugin — minimal-boot smoke test.
//
// Pins the public-surface composition contract:
//
//   defineDevstack(suiPlugin, deepbook({mode:'override', packageId, registryId, adminCapId}))
//
// compiles, validates (no `__MissingProvidersError`), and the resulting
// Stack handle exposes a `deepbook/<name>` resource id.

// Unsupported sub-features such as pools, local Pyth publishing,
// margin, server, indexer, and market-maker are intentionally absent
// from the public override options until they have real acquire behavior.
// Known deployments do surface the matching Pyth state handles; the
// exact binding shape is pinned in `test/plugins/deepbook/factory.test.ts`.
// The type-level refusals live in `test/plugins/deepbook/type-refusal.test-d.ts`.
//
// This is NOT a docker-driven boot — that lives in the (future)
// `deepbook-real-boot.test.ts` once the Move-publish substrate path
// lands. The deepbook acquire body today short-circuits to a
// resolved value populated from explicit override ids. Boot via the
// docker harness would still require the upstream Move + indexer +
// server images.
//
// The substrate-name-blind composition is the load-bearing surface
// — pin it here so the plugin's `dependsOn` tuple and the
// per-account-member ordering don't silently drift.

import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { deepbook } from '../../src/plugins/deepbook/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';

const override = {
	mode: 'override',
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
} as const;

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
});
