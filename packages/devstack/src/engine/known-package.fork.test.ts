// Phase 3 P3.T1 — `KnownPackage` composes against fork mode + the
// `resolveDeploymentNetwork(network)` helper maps each fork variant to
// its upstream's `KnownNetwork` key. Pure-unit tests (no Docker, no
// supervisor).
//
// The unit-testable surface covers:
//   - `resolveDeploymentNetwork('mainnet-fork')` → `'mainnet'`, etc.
//   - `KnownPackage` accepts the new `seedObjects` field and
//     accumulates ids into the module-level set the Sui factory reads
//     at fork acquire time.
//   - Looking up a deployment via `resolveDeploymentNetwork` + the
//     `knownDeployments` registry succeeds for the wrapped upstream.

import { afterEach, describe, expect, it } from 'vitest';
import { knownDeployments, resolveDeploymentNetwork } from './known-deployments.js';
import {
	KnownPackage,
	clearKnownPackageSeedObjects,
	collectKnownPackageSeedObjects,
} from '../services/known-package.js';

describe('Phase 3 P3.T1 — KnownPackage + fork-aware deployment lookup', () => {
	afterEach(() => {
		// Each test owns the accumulator state. Avoid cross-test leakage.
		clearKnownPackageSeedObjects();
	});

	describe('resolveDeploymentNetwork', () => {
		it('maps fork variants to their upstream KnownNetwork keys', () => {
			expect(resolveDeploymentNetwork('mainnet-fork')).toBe('mainnet');
			expect(resolveDeploymentNetwork('testnet-fork')).toBe('testnet');
			expect(resolveDeploymentNetwork('devnet-fork')).toBe('devnet');
		});

		it('passes live nets through unchanged', () => {
			expect(resolveDeploymentNetwork('mainnet')).toBe('mainnet');
			expect(resolveDeploymentNetwork('testnet')).toBe('testnet');
		});

		it('returns undefined for localnet (no canonical deployment)', () => {
			expect(resolveDeploymentNetwork('localnet')).toBeUndefined();
		});

		it('drives known-deployment lookups: mainnet-fork resolves to the real walrus deployment', () => {
			// The fork-aware plugin facades (Phase 3 P3.2 — P3.4) compose
			// this lookup: `resolveDeploymentNetwork(network)` →
			// `knownDeployments[<service>][<key>]`. This test verifies the
			// composition: a `mainnet-fork` stack composing `Walrus()`
			// sees the real mainnet Walrus system object id.
			const key = resolveDeploymentNetwork('mainnet-fork');
			expect(key).toBeDefined();
			const walrus = knownDeployments.walrus[key!];
			expect(walrus?.systemObjectId).toMatch(/^0x[0-9a-f]{64}$/);
		});

		it('drives known-deployment lookups: testnet-fork resolves to testnet deepbook', () => {
			const key = resolveDeploymentNetwork('testnet-fork');
			expect(key).toBe('testnet');
			const deepbook = knownDeployments.deepbook[key!];
			expect(deepbook?.packageId).toMatch(/^0x[0-9a-f]{64}$/);
			expect(deepbook?.registryId).toMatch(/^0x[0-9a-f]{64}$/);
		});
	});

	describe('KnownPackage seedObjects accumulator (P3.7)', () => {
		it('records seedObjects so the Sui fork builder picks them up at acquire time', () => {
			expect(collectKnownPackageSeedObjects()).toHaveLength(0);

			// Same shape a user composing `KnownPackage('walrus', {...,
			// seedObjects: ['0x...sys...']})` would write. The factory
			// returns a Ref; the seed-object side effect lands eagerly.
			KnownPackage('walrus', {
				packageId: '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
				seedObjects: [
					'0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
					'0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904',
				],
			});

			const collected = collectKnownPackageSeedObjects();
			expect(collected).toHaveLength(2);
			expect(collected).toContain(
				'0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
			);
			expect(collected).toContain(
				'0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904',
			);
		});

		it('deduplicates seedObjects across multiple KnownPackage declarations', () => {
			KnownPackage('a', {
				packageId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				seedObjects: ['0x1111111111111111111111111111111111111111111111111111111111111111'],
			});
			KnownPackage('b', {
				packageId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				seedObjects: [
					// Same id as `a` — accumulator must dedupe via Set semantics.
					'0x1111111111111111111111111111111111111111111111111111111111111111',
					'0x2222222222222222222222222222222222222222222222222222222222222222',
				],
			});

			const collected = collectKnownPackageSeedObjects();
			expect(collected).toHaveLength(2);
		});

		it('is a no-op when seedObjects is omitted', () => {
			KnownPackage('bare', {
				packageId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			});
			expect(collectKnownPackageSeedObjects()).toHaveLength(0);
		});

		it('clearKnownPackageSeedObjects resets the accumulator', () => {
			KnownPackage('x', {
				packageId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
				seedObjects: ['0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'],
			});
			expect(collectKnownPackageSeedObjects()).toHaveLength(1);
			clearKnownPackageSeedObjects();
			expect(collectKnownPackageSeedObjects()).toHaveLength(0);
		});
	});
});
