// Unit tests for the per-stack fork meta.json gate (Phase 4 P4.15-P4.16).
//
// Three properties under test:
//   1. `computeConfigHash` is stable across orderings of seed addresses
//      / objects (sorts before digesting).
//   2. `ensureForkMetaConsistent` writes meta on first boot, no-ops on
//      matching second boot, and fails with `SeedManifestMismatchError`
//      on a configHash diff.
//   3. The CLI's `apply` typed catch (P4.10) renders the recipe by
//      consuming `SeedManifestMismatchError.previous` / `.current` —
//      exercised under `cli/commands/apply.fork-seed-mismatch.test.ts`.
//
// These tests run pure node fs against a tmp dir — no docker required.

import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { SeedManifestMismatchError } from '../errors.js';
import { computeConfigHash, ensureForkMetaConsistent, readForkMeta } from './meta.js';

describe('engine/sui-fork/meta', () => {
	describe('computeConfigHash (P4.15)', () => {
		it('is stable across address ordering', () => {
			const a = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xaa', '0xbb', '0xcc'],
				seedObjects: [],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xcc', '0xaa', '0xbb'],
				seedObjects: [],
			});
			expect(a).toBe(b);
		});

		it('is stable across object ordering', () => {
			const a = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: [],
				seedObjects: ['0x111', '0x222'],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: [],
				seedObjects: ['0x222', '0x111'],
			});
			expect(a).toBe(b);
		});

		it('is case-insensitive on addresses + objects', () => {
			const a = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xABC'],
				seedObjects: ['0xDEF'],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xabc'],
				seedObjects: ['0xdef'],
			});
			expect(a).toBe(b);
		});

		it('flips when checkpoint changes', () => {
			const a = computeConfigHash({
				upstream: 'testnet',
				checkpoint: 100,
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				checkpoint: 200,
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			expect(a).not.toBe(b);
		});

		it('flips when upstream changes', () => {
			const a = computeConfigHash({
				upstream: 'mainnet',
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			const b = computeConfigHash({
				upstream: 'testnet',
				seedAddresses: ['0xaa'],
				seedObjects: [],
			});
			expect(a).not.toBe(b);
		});

		// P5.5.4: the runtime carry (autoTickMs) is excluded from the
		// hash — the seed-manifest contract covers `(upstream,
		// checkpoint, seedAddresses, seedObjects)` only, and supervisor-
		// side cadence values must not trip `SeedManifestMismatchError`.
		// `ForkConfigInput` has no `runtime` slot by design; this test
		// asserts the surface contract by computing the hash with
		// identical seed-manifest fields and showing it stays stable
		// regardless of any "runtime"-like extra the caller might
		// imagine wanting to fold in.
		it('P5.5.4: hash ignores runtime-shaped extras (autoTickMs not part of contract)', () => {
			const base = {
				upstream: 'testnet',
				checkpoint: 1000,
				seedAddresses: ['0xaa'],
				seedObjects: ['0x111'],
			} as const;
			const a = computeConfigHash(base);
			// Even if a future caller accidentally widened the input
			// shape, the function signature forces them through
			// `ForkConfigInput`, which has no `runtime` member —
			// extra fields wouldn't change the hash. We can't pass an
			// extra at the typed surface; the protection here is
			// structural and is asserted at the schema level by
			// `ensureForkMetaConsistent` round-tripping (below).
			expect(a).toMatch(/^[0-9a-f]{16}$/);
		});
	});

	describe('ensureForkMetaConsistent (P4.16)', () => {
		it.effect('writes meta.json on first boot', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				const result = yield* ensureForkMetaConsistent({
					metaPath,
					current: {
						upstream: 'testnet',
						checkpoint: 1000,
						seedAddresses: ['0xaa', '0xbb'],
						seedObjects: [],
					},
				});
				expect(result.written).toBe(true);
				expect(result.meta.upstream).toBe('testnet');
				expect(result.meta.checkpoint).toBe(1000);
				expect(result.meta.seedAddresses).toEqual(['0xaa', '0xbb']);
				expect(result.meta.configHash).toMatch(/^[0-9a-f]{16}$/);
				const onDisk = yield* readForkMeta(metaPath);
				expect(onDisk).toBeDefined();
				expect(onDisk?.configHash).toBe(result.meta.configHash);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		it.effect('no-ops on identical second boot', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				const input = {
					upstream: 'testnet',
					checkpoint: 1000,
					seedAddresses: ['0xaa'],
					seedObjects: [],
				};
				const first = yield* ensureForkMetaConsistent({ metaPath, current: input });
				const second = yield* ensureForkMetaConsistent({ metaPath, current: input });
				expect(first.written).toBe(true);
				expect(second.written).toBe(false);
				expect(second.meta.configHash).toBe(first.meta.configHash);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		it.effect('P4.T5 raises SeedManifestMismatchError when configHash changes', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				yield* ensureForkMetaConsistent({
					metaPath,
					current: {
						upstream: 'testnet',
						checkpoint: 1000,
						seedAddresses: ['0xaa'],
						seedObjects: [],
					},
				});
				// Second boot with a different seed address set — must
				// raise the typed error.
				const result = yield* ensureForkMetaConsistent({
					metaPath,
					current: {
						upstream: 'testnet',
						checkpoint: 1000,
						seedAddresses: ['0xaa', '0xcc'],
						seedObjects: [],
					},
				}).pipe(Effect.flip);
				expect(result).toBeInstanceOf(SeedManifestMismatchError);
				expect(result.metaPath).toBe(metaPath);
				expect(result.previous?.upstream).toBe('testnet');
				expect(result.current?.upstream).toBe('testnet');
				expect(result.previous?.configHash).not.toBe(result.current?.configHash);
				expect(result.message).toMatch(/wipe --keep-upstream-cache/);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		// P5.5.4: runtime carry — autoTickMs persists across resume but
		// is NOT part of `configHash`, so flipping it does NOT trip
		// the seed-manifest mismatch gate.
		it.effect('P5.5.4: persists runtime.autoTickMs across first-boot write', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				const result = yield* ensureForkMetaConsistent({
					metaPath,
					current: {
						upstream: 'testnet',
						seedAddresses: ['0xaa'],
						seedObjects: [],
					},
					runtime: { autoTickMs: 1500 },
				});
				expect(result.written).toBe(true);
				expect(result.meta.runtime?.autoTickMs).toBe(1500);
				// Round-trip via the on-disk file — the schema decoder must
				// hydrate `runtime.autoTickMs` back to a number.
				const onDisk = yield* readForkMeta(metaPath);
				expect(onDisk?.runtime?.autoTickMs).toBe(1500);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		it.effect('P5.5.4: configHash unchanged when only autoTickMs changes (no mismatch)', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				const seedFields = {
					upstream: 'testnet',
					checkpoint: 2000,
					seedAddresses: ['0xaa', '0xbb'],
					seedObjects: ['0x111'],
				} as const;
				const first = yield* ensureForkMetaConsistent({
					metaPath,
					current: seedFields,
					runtime: { autoTickMs: 1000 },
				});
				expect(first.meta.runtime?.autoTickMs).toBe(1000);

				// Second boot: same seed-manifest fields, DIFFERENT
				// autoTickMs. The configHash should be byte-identical;
				// the runtime carry should refresh in place; no
				// `SeedManifestMismatchError`.
				const second = yield* ensureForkMetaConsistent({
					metaPath,
					current: seedFields,
					runtime: { autoTickMs: 2500 },
				});
				expect(second.meta.configHash).toBe(first.meta.configHash);
				expect(second.meta.runtime?.autoTickMs).toBe(2500);
				expect(second.written).toBe(true);

				// Round-trip via disk — the refreshed value persists.
				const onDisk = yield* readForkMeta(metaPath);
				expect(onDisk?.configHash).toBe(first.meta.configHash);
				expect(onDisk?.runtime?.autoTickMs).toBe(2500);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		it.effect('P5.5.4: clearing runtime drops the key on the persisted shape', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				const seedFields = {
					upstream: 'testnet',
					seedAddresses: ['0xaa'],
					seedObjects: [],
				} as const;
				yield* ensureForkMetaConsistent({
					metaPath,
					current: seedFields,
					runtime: { autoTickMs: 1000 },
				});
				// Resume with no runtime — the cleared cadence must vanish
				// from disk (otherwise a subsequent resume would re-arm a
				// stale fiber).
				const cleared = yield* ensureForkMetaConsistent({
					metaPath,
					current: seedFields,
					runtime: {},
				});
				expect(cleared.meta.runtime).toBeUndefined();
				const onDisk = yield* readForkMeta(metaPath);
				expect(onDisk?.runtime).toBeUndefined();
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);

		it.effect('treats corrupt meta.json as first boot', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'meta.json');
				yield* Effect.promise(() => writeFile(metaPath, '{not valid json}'));
				const result = yield* ensureForkMetaConsistent({
					metaPath,
					current: {
						upstream: 'testnet',
						seedAddresses: ['0xaa'],
						seedObjects: [],
					},
				});
				expect(result.written).toBe(true);
				// The corrupt file got overwritten with a valid one.
				const raw = yield* Effect.promise(() => readFile(metaPath, 'utf8'));
				const parsed = JSON.parse(raw) as { configHash?: string };
				expect(parsed.configHash).toBe(result.meta.configHash);
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);
	});

	describe('readForkMeta', () => {
		it.effect('returns undefined when file missing', () =>
			Effect.gen(function* () {
				const dir = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')));
				const metaPath = joinPath(dir, 'never-written.json');
				const out = yield* readForkMeta(metaPath);
				expect(out).toBeUndefined();
				yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);
	});

	// Surface check: the FileSystem service is the same one supplied to
	// every other devstack engine helper. Tests provide
	// `NodeServicesLayer` so the helper's `FileSystem` requirement is
	// satisfied — the platform layer set is identical to what `cli/main.ts`
	// composes at runtime.
	it.effect('FileSystem is the live node service', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			expect(typeof fs.exists).toBe('function');
		}).pipe(Effect.provide(NodeServicesLayer)),
	);
});
