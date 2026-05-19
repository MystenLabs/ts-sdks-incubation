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
import {
	computeConfigHash,
	ensureForkMetaConsistent,
	readForkMeta,
} from './meta.js';

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

		it.effect(
			'P4.T5 raises SeedManifestMismatchError when configHash changes',
			() =>
				Effect.gen(function* () {
					const dir = yield* Effect.promise(() =>
						mkdtemp(joinPath(tmpdir(), 'devstack-fork-meta-')),
					);
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
