// Factory-shape tests for the deepbook plugin. Pin the public
// surface (`deepbook(...)`, `deepbookFor(...)`) so regressions
// surface here, not in the e2e harness.

import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { deepbook, deepbookFor } from '../../../src/plugins/deepbook/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import { MEMBER_BRAND } from '../../../src/substrate/plugin.ts';

describe('deepbook(opts) — primary factory', () => {
	it('refuses local mode without a publisher (sync DeepbookConfigError)', () => {
		expect(() => deepbook({ mode: 'local' } as never)).toThrow(/publisher/);
	});

	it('produces a branded StackMember for local mode', () => {
		const publisher = account('publisher');
		const member = deepbook({ mode: 'local', publisher });
		expect(member[MEMBER_BRAND]).toBe(true);
		expect(member.provides.id).toMatch(/^deepbook\//);
		expect(member.kind).toBe('composite');
	});

	it('represents the publisher direct-value ref in consumes', () => {
		const publisher = account('publisher');
		const member = deepbook({ mode: 'local', publisher });
		expect(member.consumes.map((tag) => tag.id)).toEqual(['sui', 'account/publisher']);
	});

	it('produces a leaf-one-shot for known mode', () => {
		const member = deepbook({
			mode: 'known',
			packageId: '0xpkg',
			registryId: '0xreg',
			chain: 'sui:testnet',
		});
		expect(member.kind).toBe('leaf-one-shot');
		expect(member.provides.id).toMatch(/^deepbook\//);
	});

	it('folds the instance name into the tag id', () => {
		const member = deepbook({
			mode: 'known',
			packageId: '0xpkg',
			registryId: '0xreg',
			chain: 'sui:testnet',
			name: 'arena',
		});
		expect(member.provides.id).toBe('deepbook/arena');
	});
});

describe('deepbookFor(network) — mode-narrowed namespace', () => {
	it('exposes `.local` on a local network', () => {
		const network = { mode: 'local' as const, chain: chainId('sui:localnet') };
		const factories = deepbookFor.for(network);
		expect(typeof factories.local).toBe('function');
		expect(typeof factories.known).toBe('function');
	});

	it('exposes `.known` (only) on a live network', () => {
		const network = { mode: 'live' as const, chain: chainId('sui:testnet') };
		const factories = deepbookFor.for(network);
		expect(typeof factories.known).toBe('function');
		// `factories.local` doesn't exist on this branch — accessing
		// it would be a compile error. Runtime check: the property
		// is undefined.
		expect((factories as { local?: unknown }).local).toBeUndefined();
	});

	it('exposes `.known` and refuses `.local` on a fork network', () => {
		const network = {
			mode: 'fork' as const,
			chain: chainId('sui:mainnet-fork'),
			upstream: 'mainnet' as const,
		};
		const factories = deepbookFor.for(network);
		expect(typeof factories.known).toBe('function');
		// Defense-in-depth runtime refusal — the type-level refusal
		// is the primary mechanism (`.local` does not exist on the
		// fork branch's typed surface).
		expect((factories as { local?: unknown }).local).toBeUndefined();
		expect(() => factories._localRefused?.('sui:mainnet-fork')).toThrow(/fork/i);
	});
});

describe('deepbook unsupported convenience factories', () => {
	it('does not expose dotted helpers that cannot acquire real release behavior', () => {
		const surface = deepbook as {
			readonly indexer?: unknown;
			readonly server?: unknown;
			readonly marketMaker?: unknown;
			readonly mintDEEP?: unknown;
			readonly mintUSDC?: unknown;
		};
		expect(surface.indexer).toBeUndefined();
		expect(surface.server).toBeUndefined();
		expect(surface.marketMaker).toBeUndefined();
		expect(surface.mintDEEP).toBeUndefined();
		expect(surface.mintUSDC).toBeUndefined();
	});
});
