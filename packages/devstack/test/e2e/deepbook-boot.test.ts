// Deepbook composite — minimal-boot smoke test.
//
// Pins the public-surface composition contract:
//
//   defineDevstack(suiPlugin, publisher, deepbook({mode:'local', publisher}))
//
// compiles, validates (no `__MissingProvidersError`), and the resulting
// Stack handle exposes a `deepbook/<name>` resource id.
//
// Unsupported local sub-features such as pools, local Pyth publishing,
// margin, server, indexer, and market-maker are intentionally absent
// from the public local options until they have real acquire behavior.
// Known deployments do surface the matching Pyth state handles; the
// exact binding shape is pinned in `test/plugins/deepbook/factory.test.ts`.
// The type-level refusals live in `test/plugins/deepbook/type-refusal.test-d.ts`.
//
// This is NOT a docker-driven boot — that lives in the (future)
// `deepbook-real-boot.test.ts` once the Move-publish substrate path
// lands. The deepbook acquire body today short-circuits to a
// resolved value populated from override env (matches the
// walrus-stub-boot.test.ts staged-stub pattern). Boot via the
// docker harness would still require the upstream Move + indexer +
// server images.
//
// The substrate-name-blind composition is the load-bearing surface
// — pin it here so the composite's `dependsOn` tuple and the
// per-account-member ordering don't silently drift.

import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { account } from '../../src/plugins/account/index.ts';
import { deepbook } from '../../src/plugins/deepbook/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';

describe('deepbook + sui.local() composes via defineDevstack', () => {
	it('local mode composes with a publisher account ref', () => {
		const suiPlugin = sui();
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher, name: 'main' });

		const stack = defineDevstack({
			members: [suiPlugin, publisher, dex],
			stackName: 'deepbook-smoke',
		});
		expect(stack._tag).toBe('Stack');
		expect(readStackEngine(stack).members.length).toBe(3);
		const ids = readStackEngine(stack).members.map((m) => m.id);
		expect(ids).toContain('sui');
		expect(ids).toContain('account/publisher');
		expect(ids).toContain('deepbook/main');
	});

	it('local mode threads the publisher account ref through dependencies', () => {
		const publisher = account('publisher');
		const dex = deepbook({
			mode: 'local',
			publisher,
			name: 'arena',
		});
		expect(dex.id).toBe('deepbook/arena');
		expect(dex.kind).toBe('composite');
		expect(dex.dependsOn.map((resource) => resource.id)).toEqual(['sui', 'account/publisher']);
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
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher });
		expect(dex.id).toBe('deepbook/deepbook');
	});

	it('composite declares a stable plugin metadata key', () => {
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher, name: 'main' });
		expect(String(dex.composite?.key)).toBe('deepbook:main');
	});
});
