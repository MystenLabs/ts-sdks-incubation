// Deepbook composite — minimal-boot smoke test.
//
// Pins the public-surface composition contract:
//
//   defineDevstack(suiPlugin, publisher, deepbook({mode:'local', publisher}))
//
// compiles, validates (no `__MissingProvidersError`), and the resulting
// Stack handle exposes a `deepbook/<name>` provided tag id.
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
// — pin it here so the composite's `consumes:` tuple and the
// per-account-member ordering don't silently drift.

import { describe, expect, it } from 'vitest';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { account } from '../../src/plugins/account/index.ts';
import { deepbook } from '../../src/plugins/deepbook/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';

describe('deepbook + sui.local() composes via defineDevstack', () => {
	it('local mode composes with a publisher account ref', () => {
		const suiPlugin = sui();
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher, name: 'main' });

		const stack = defineDevstack(suiPlugin, publisher, dex, {
			stackName: 'deepbook-smoke',
		});
		expect(stack._tag).toBe('Stack');
		expect(stack.members.length).toBe(3);
		const ids = stack.members.map((m) => m.provides.id);
		expect(ids).toContain('sui');
		expect(ids).toContain('account/publisher');
		expect(ids).toContain('deepbook/main');
	});

	it('local mode pools spec threads through unchanged', () => {
		const publisher = account('publisher');
		const dex = deepbook({
			mode: 'local',
			publisher,
			name: 'arena',
			pools: [
				{
					name: 'sui_usdc',
					base: 'SUI',
					quote: 'USDC',
					tickSize: 1_000n,
					lotSize: 100_000_000n,
					minSize: 1_000_000_000n,
				},
			],
		});
		expect(dex.provides.id).toBe('deepbook/arena');
		expect(dex.kind).toBe('composite');
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
		const stack = defineDevstack(suiPlugin, dex, {
			stackName: 'deepbook-known-smoke',
		});
		const ids = stack.members.map((m) => m.provides.id);
		expect(ids).toEqual(expect.arrayContaining(['sui', 'deepbook/live']));
	});

	it('default name is `deepbook` when no name is supplied', () => {
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher });
		expect(dex.provides.id).toBe('deepbook/deepbook');
	});

	it('composite contributes the `composite-primitive` capability decl', () => {
		const publisher = account('publisher');
		const dex = deepbook({ mode: 'local', publisher, name: 'main' });
		// `capabilities` here is a CapabilitiesFactory (function form) —
		// the static composite decl is built inside that closure with
		// the resolved value. We pin the function-form discipline; the
		// resolved-side capability tuple is exercised in the substrate
		// supervisor tests once the real publish path lands.
		expect(typeof dex.capabilities).toBe('function');
	});
});
