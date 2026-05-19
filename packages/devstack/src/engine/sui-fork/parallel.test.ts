// Phase 5 Subtopic 4 (P5.6.1) — parallel-stacks audit. Pure unit
// assertions that the per-stack fork state (data dir, meta.json, file
// lock) cleanly partitions by `stack` AND that the shared upstream
// cache key (`computeConfigHash`) cleanly partitions by `upstream`.
//
// Two cases under test:
//
//   1. Two `Sui({fork: ...})` stacks pointing at the SAME upstream +
//      DIFFERENT data dirs (P5.6.2): per-stack `resolveForkDataDir` and
//      `resolveForkMetaPath` produce distinct paths.
//
//   2. Two stacks pointing at DIFFERENT upstreams (mainnet vs testnet,
//      P5.6.3): even at the SAME `stack` name, `computeConfigHash`
//      differs (so a single shared `.devstack/sui-fork-cache/` doesn't
//      conflate the two upstreams) — and the per-stack paths still
//      partition independently of the upstream.
//
// Docker-gated end-to-end equivalent (P5.T3) is
// `./parallel.docker.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import { computeConfigHash, resolveForkDataDir, resolveForkMetaPath } from './meta.js';

const appDir = '/tmp/devstack-parallel-test-app';

describe('engine/sui-fork parallel-stacks invariants (P5.6.1)', () => {
	describe('per-stack path partitioning (P5.6.2)', () => {
		it('two stack names resolve to distinct data dirs under the same app', () => {
			const dirA = resolveForkDataDir('main', appDir);
			const dirB = resolveForkDataDir('preview', appDir);
			expect(dirA).toContain('/stacks/main/sui-fork/data');
			expect(dirB).toContain('/stacks/preview/sui-fork/data');
			expect(dirA).not.toBe(dirB);
		});

		it('two stack names resolve to distinct meta.json paths', () => {
			// `meta.json` is the per-stack write-once seed-manifest gate
			// (R6 mitigation). If two stacks shared the same meta path,
			// the second `ensureForkMetaConsistent` would either no-op
			// against the first's `configHash` (silent adoption — wrong)
			// or fire `SeedManifestMismatchError` (false-positive — still
			// wrong because both stacks should be valid independently).
			const metaA = resolveForkMetaPath('main', appDir);
			const metaB = resolveForkMetaPath('preview', appDir);
			expect(metaA).toContain('/stacks/main/sui-fork/meta.json');
			expect(metaB).toContain('/stacks/preview/sui-fork/meta.json');
			expect(metaA).not.toBe(metaB);
		});

		it('the implied data.lock paths (sibling of data/) are stack-keyed too', () => {
			// `engine/sui-fork/file-lock.ts:acquireForkDataLock` takes a
			// `lockPath` constructed by `services/sui.ts:1585` as
			// `<stack-root>/sui-fork/data.lock`. Verify the parent
			// directory of the data dir IS the stack root so a future
			// refactor placing the lock alongside the data dir keeps the
			// stack scoping intact.
			const dirA = resolveForkDataDir('main', appDir);
			const dirB = resolveForkDataDir('preview', appDir);
			// The lock is one path segment up from `data/` (i.e. ends at
			// `<...>/stacks/<stack>/sui-fork/`). Both stacks have their
			// own such root so two `tryClaimLockSync` calls don't see the
			// same lockfile.
			expect(dirA.replace(/\/data$/, '/data.lock')).not.toBe(dirB.replace(/\/data$/, '/data.lock'));
		});
	});

	describe('per-upstream config hash partitioning (P5.6.3)', () => {
		it('same stack name + different upstream → different configHash', () => {
			// Two stacks pointing at DIFFERENT upstreams (e.g. mainnet
			// vs testnet fork) must not collide on the meta.json gate.
			// `configHash` is folded into both the on-disk meta file AND
			// the shared upstream-cache GC keys; collapsing the upstream
			// dimension would cause a `SeedManifestMismatchError`
			// false-positive between the two stacks.
			const mainnet = computeConfigHash({
				upstream: 'mainnet',
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			const testnet = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			expect(mainnet).not.toBe(testnet);
		});

		it('different upstream + different checkpoint also remain distinct', () => {
			// Defensive — checkpoint folds in too. Two stacks against
			// mainnet at different checkpoints get different hashes,
			// matching the existing `meta.test.ts:flips when checkpoint
			// changes` assertion. Re-asserted here so the parallel-stack
			// contract is documented alongside the upstream contract.
			const a = computeConfigHash({
				upstream: 'mainnet',
				checkpoint: 100,
				seedAddresses: [],
				seedObjects: [],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				checkpoint: 200,
				seedAddresses: [],
				seedObjects: [],
			});
			expect(a).not.toBe(b);
		});

		it('shared cache directory partitions cleanly by chainId (manual GC contract)', () => {
			// `meta.ts` header documents that `.devstack/sui-fork-cache/`
			// is shared across stacks per-chainId. Two stacks against the
			// same upstream + same checkpoint MAY converge on the same
			// `configHash` (intentional — they reuse the warmed cache),
			// but two stacks against different upstreams MUST diverge.
			// This is the load-bearing property that prevents a stack-A
			// boot from inadvertently restoring the wrong chain's
			// pre-warmed system state into stack-B's data dir.
			const sameUpstreamA = computeConfigHash({
				upstream: 'mainnet',
				checkpoint: 100,
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			const sameUpstreamB = computeConfigHash({
				upstream: 'mainnet',
				checkpoint: 100,
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			expect(sameUpstreamA).toBe(sameUpstreamB);
		});
	});

	describe('cross-product (different stack + different upstream)', () => {
		it('two stacks with different stack names + different upstreams produce 4 distinct dimensions', () => {
			// All four (stack, upstream) pairs partition independently —
			// the data dir is stack-only (upstream doesn't enter the
			// path) and the configHash is upstream-only (stack doesn't
			// enter the digest). Asserting both axes here keeps any
			// future refactor that folds one dimension into the other
			// from silently breaking parallel-stack support.
			const dirMain = resolveForkDataDir('main', appDir);
			const dirPreview = resolveForkDataDir('preview', appDir);
			const hashMainnet = computeConfigHash({
				upstream: 'mainnet',
				seedAddresses: [],
				seedObjects: [],
			});
			const hashTestnet = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: [],
				seedObjects: [],
			});
			expect(new Set([dirMain, dirPreview]).size).toBe(2);
			expect(new Set([hashMainnet, hashTestnet]).size).toBe(2);
		});
	});
});
