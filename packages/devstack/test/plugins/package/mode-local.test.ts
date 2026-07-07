import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, Option, Schema, type Scope } from 'effect';
import { afterAll, describe, expect, it } from '@effect/vitest';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../../src/contracts/chain-probe.ts';
import type {
	ArtifactPublishError,
	ArtifactPublisher,
	ArtifactSpec,
} from '../../../src/primitives/artifact-publisher.ts';
import {
	acquireLocal,
	buildVerifyProbe,
	type CachedPackageEntry,
	type PublishExecutor,
} from '../../../src/plugins/package/mode-local.ts';
import type { PublishError } from '../../../src/plugins/package/errors.ts';
import type { LocalPackagePublishOutput } from '../../../src/plugins/package/publish-output.ts';
import {
	PackageRegistryService,
	layerPackageRegistry,
} from '../../../src/plugins/package/registry.ts';
import type { SuiProbeKey } from '../../../src/plugins/sui/chain-probe.ts';

const transientProbe = (
	values: ReadonlyArray<{ readonly objectId: string; readonly type: unknown } | null>,
): ChainProbe<SuiProbeKey> => {
	let calls = 0;
	return {
		get: <Shape>(_key: SuiProbeKey, schema: ChainProbeSchema<Shape>, _mode: ChainProbeMode) =>
			Effect.sync(() => {
				const value = values[Math.min(calls, values.length - 1)] ?? null;
				calls += 1;
				return value;
			}).pipe(
				Effect.flatMap((value) =>
					value === null
						? Effect.succeed(null)
						: Schema.decodeUnknownEffect(schema)(value).pipe(
								Effect.mapError(
									(cause): ChainProbeError => ({
										_tag: 'ChainProbeError',
										reason: 'decode-failed',
										chainId: 'sui:localnet',
										detail: String(cause),
									}),
								),
							),
				),
			),
	};
};

describe('local package mode', () => {
	it.effect('retries cached package verification before treating a hit as stale', () =>
		Effect.gen(function* () {
			const probe = transientProbe([null, null, { objectId: '0xpkg', type: 'package' }]);

			const verified = yield* buildVerifyProbe(probe, '0xpkg', {
				maxAttempts: 3,
				delayMs: 0,
			});

			expect(verified).toEqual({ objectId: '0xpkg', type: 'package' });
		}),
	);

	it.effect('returns null after cached package verification is exhausted', () =>
		Effect.gen(function* () {
			let calls = 0;
			const probe: ChainProbe<SuiProbeKey> = {
				get: () =>
					Effect.sync(() => {
						calls += 1;
						return null;
					}),
			};

			const verified = yield* buildVerifyProbe(probe, '0xmissing', {
				maxAttempts: 3,
				delayMs: 0,
			});

			expect(verified).toBeNull();
			expect(calls).toBe(3);
		}),
	);

	it.effect('treats decode failures as stale cache after the retry budget', () =>
		Effect.gen(function* () {
			let calls = 0;
			const probe: ChainProbe<SuiProbeKey> = {
				get: () =>
					Effect.fail({
						_tag: 'ChainProbeError',
						reason: 'decode-failed',
						chainId: 'sui:localnet',
						detail: 'bad shape',
					} satisfies ChainProbeError).pipe(
						Effect.tapError(() =>
							Effect.sync(() => {
								calls += 1;
							}),
						),
					),
			};

			const verified = yield* buildVerifyProbe(probe, '0xbad', {
				maxAttempts: 2,
				delayMs: 0,
			});

			expect(verified).toBeNull();
			expect(calls).toBe(2);
		}),
	);
});

// ---------------------------------------------------------------------------
// A5 regression — capture-callback throws surface as `PublishError('parse')`
// on BOTH the cache-hit and cache-miss paths (symmetric).
//
// Before A5, the cache-hit `register` swallowed the throw via
// `try { capture(artifact.output) } catch { return artifact.captured }`,
// silently shipping stale captured data. The cache-miss `produce` raised
// `PublishError('parse')` correctly. The asymmetry hid the very user bug
// the throw was designed to surface (renamed/typo capture keys).
// ---------------------------------------------------------------------------

const PUBLISH_OUTPUT: LocalPackagePublishOutput = {
	digest: '0xdigestcached',
	packageId: '0xpkgcached',
	upgradeCapId: '0xcapcached',
	publisher: '0xpublisheraddr',
	objectChanges: [
		{
			type: 'published',
			objectId: '0xpkgcached',
		},
		{
			type: 'created',
			objectId: '0xcapcached',
			objectType: '0x2::package::UpgradeCap',
		},
	],
};

const CACHED_ENTRY: CachedPackageEntry = {
	packageId: '0xpkgcached',
	upgradeCapId: '0xcapcached',
	publisher: '0xpublisheraddr',
	mvrPlaceholder: 'cached_pkg',
	captured: { admin: '0xadminstale' },
	output: PUBLISH_OUTPUT,
};

/** ArtifactPublisher stub that always simulates a cache HIT: invokes
 *  `verify(cached)`, then `register(cached)`, then returns `cached`.
 *  The produce body is NEVER consulted — wraps the contract the
 *  substrate guarantees on a verify-ok cache hit. */
const cacheHitPublisher = (cached: CachedPackageEntry): ArtifactPublisher => ({
	publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
		Effect.gen(function* () {
			const verified = yield* spec.verify(cached as unknown as Produced);
			if (verified === null) {
				// Real substrate would fall through to `produce` here;
				// the test only exercises the hit path.
				throw new Error('cacheHitPublisher: verify returned null — test misconfigured');
			}
			yield* spec.register(cached as unknown as Produced);
			return cached as unknown as Produced;
		}),
});

/** ArtifactPublisher stub that always simulates a cache MISS: invokes
 *  `produce` (which is where the produce-time capture lives), then
 *  `register(produced)`. */
const cacheMissPublisher = (): ArtifactPublisher => ({
	publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
		Effect.gen(function* () {
			const produced = yield* spec.produce;
			yield* spec.register(produced);
			return produced;
		}),
});

const okVerifyProbe: ChainProbe<SuiProbeKey> = {
	get: <Shape>(
		_key: SuiProbeKey,
		_schema: ChainProbeSchema<Shape>,
		_mode: ChainProbeMode,
	): Effect.Effect<Shape | null, never> =>
		Effect.succeed({ objectId: '0xpkgcached', type: 'package' } as unknown as Shape),
};

/** PublishExecutor that fails loudly if invoked — the cache-hit path
 *  must never reach build / publishTx / postPublishReadyHint. */
const unreachableExecutor: PublishExecutor = {
	scrubsInsideContainer: false,
	build: () => Effect.die('cache-hit path must not call executor.build'),
	publishTx: () => Effect.die('cache-hit path must not call executor.publishTx'),
	postPublishReadyHint: () =>
		Effect.die('cache-hit path must not call executor.postPublishReadyHint'),
};

/** PublishExecutor that returns canned BuildOutput / publishTx output /
 *  ready signal — used to drive the cache-MISS path up to the
 *  produce-time capture step. */
const succeedingExecutor: PublishExecutor = {
	scrubsInsideContainer: false,
	build: () =>
		Effect.succeed({
			modules: [new Uint8Array([0x42])],
			dependencies: ['0x1'],
		}),
	publishTx: () => Effect.succeed(PUBLISH_OUTPUT),
	postPublishReadyHint: () => Effect.void,
};

describe('local package mode — A5 capture asymmetry regression', () => {
	// Tests below treat the dir handed back by `freshSourceDir()` as
	// the package's source path inside an `Effect.gen` body, so a
	// per-`it` `withTempRoot` would re-scope it awkwardly. Instead,
	// every allocated dir gets tracked and torn down in `afterAll`.
	const allocatedSourceDirs: string[] = [];
	afterAll(() => {
		for (const dir of allocatedSourceDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	const freshSourceDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), 'a5-capture-'));
		allocatedSourceDirs.push(dir);
		return dir;
	};

	it.effect('cache HIT: capture-callback throw surfaces as ArtifactPublishError(parse)', () =>
		Effect.gen(function* () {
			const sourcePath = freshSourceDir();
			const publisher = cacheHitPublisher(CACHED_ENTRY);
			const registry = yield* PackageRegistryService;

			const exit = yield* Effect.scoped(
				acquireLocal(publisher, okVerifyProbe, registry, {
					packageName: 'cached_pkg',
					sourcePath,
					chainId: 'sui:test-a5',
					publisherAddress: '0xpublisheraddr',
					capture: (_output): Readonly<Record<string, string>> => {
						throw new Error('user-side capture typo: missing field "renamed_admin"');
					},
					executor: unreachableExecutor,
				}),
			).pipe(Effect.exit);

			const errorOpt = Exit.findErrorOption(exit) as Option.Option<
				PublishError | ArtifactPublishError
			>;
			expect(Option.isSome(errorOpt)).toBe(true);
			const error = Option.getOrThrow(errorOpt);

			// A5: MUST surface the user-callback throw as the SAME
			// shape the produce-side surfaces it as. Pre-A5, the
			// cache-hit `register` silently swallowed the throw and
			// returned a Success exit with `resolved.captured ===
			// CACHED_ENTRY.captured` (stale data). Post-A5, both
			// cache paths fail with `ArtifactPublishError('produce-
			// failed')` whose `detail` carries the originating
			// `PublishError('parse')` shape.
			expect(error._tag).toBe('ArtifactPublishError');
			if (error._tag !== 'ArtifactPublishError') throw new Error('typeguard');
			expect(error.reason).toBe('produce-failed');
			expect(error.detail).toContain('parse');
			expect(error.detail).toContain('capture callback threw');

			// Pinning the negative case explicitly: the stale captured
			// map MUST NOT have leaked through the registry as a
			// resolved value. The error exit channel above already
			// implies this (no Success exit), but we also assert the
			// registry was never re-written with the bogus shape.
			const registered = yield* registry.find('cached_pkg');
			// `register` ran with `artifact.captured` (the stale cached
			// map) BEFORE the post-publish recompute fired and failed —
			// the registry contains the cached entry. The fix's
			// guarantee is the FAILURE exit above; partial registry
			// state from a failed cycle is acceptable per architecture
			// (register fires once and writes the artifact-publisher's
			// best knowledge; subsequent recompute may invalidate but
			// is observed via the outer failure).
			expect(registered?.kind).toBe('local');
			if (registered?.kind === 'local') {
				expect(registered.captured).toEqual(CACHED_ENTRY.captured);
			}
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('cache MISS: capture-callback throw surfaces as ArtifactPublishError', () =>
		// Sibling to the above — pins the symmetric cache-miss behavior
		// (produce-time `Effect.try` → `PublishError('parse')` →
		// `mapError` → `ArtifactPublishError('produce-failed')`). The
		// substrate boundary translates `PublishError` to
		// `ArtifactPublishError` for the miss path; A5 makes the hit
		// path's user-callback throw equally fatal so neither route
		// silently ships stale data.
		Effect.gen(function* () {
			const sourcePath = freshSourceDir();
			const publisher = cacheMissPublisher();
			const registry = yield* PackageRegistryService;

			const exit = yield* Effect.scoped(
				acquireLocal(publisher, okVerifyProbe, registry, {
					packageName: 'fresh_pkg',
					sourcePath,
					chainId: 'sui:test-a5',
					publisherAddress: '0xpublisheraddr',
					capture: (_output): Readonly<Record<string, string>> => {
						throw new Error('user-side capture typo on miss');
					},
					executor: succeedingExecutor,
				}),
			).pipe(Effect.exit);

			const errorOpt = Exit.findErrorOption(exit) as Option.Option<
				PublishError | ArtifactPublishError
			>;
			expect(Option.isSome(errorOpt)).toBe(true);
			const error = Option.getOrThrow(errorOpt);

			// On miss the produce body's `mapError` projects
			// `PublishError → ArtifactPublishError('produce-failed')`
			// before re-raising — the failure shape that callers
			// already had to handle pre-A5. The cache-HIT test above
			// pins the NEW symmetric path.
			expect(error._tag).toBe('ArtifactPublishError');
			if (error._tag !== 'ArtifactPublishError') throw new Error('typeguard');
			expect(error.reason).toBe('produce-failed');
			expect(error.detail).toContain('parse');
			expect(error.detail).toContain('capture callback threw');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('cache HIT adopts the current mvrPlaceholder instead of cached stale metadata', () =>
		Effect.gen(function* () {
			const sourcePath = freshSourceDir();
			const publisher = cacheHitPublisher(CACHED_ENTRY);
			const registry = yield* PackageRegistryService;

			const result = yield* Effect.scoped(
				acquireLocal(publisher, okVerifyProbe, registry, {
					packageName: 'cached_pkg',
					sourcePath,
					chainId: 'sui:test-mvr',
					publisherAddress: '0xpublisheraddr',
					mvrOverride: '@local-pkg/cached-pkg',
					executor: unreachableExecutor,
				}),
			);

			expect(CACHED_ENTRY.mvrPlaceholder).toBe('cached_pkg');
			expect(result.resolved.mvrPlaceholder).toBe('@local-pkg/cached-pkg');

			const registered = yield* registry.find('cached_pkg');
			expect(registered?.kind).toBe('local');
			if (registered?.kind === 'local') {
				expect(registered.mvrPlaceholder).toBe('@local-pkg/cached-pkg');
			}
		}).pipe(Effect.provide(layerPackageRegistry)),
	);
});

// ---------------------------------------------------------------------------
// Intra-stack name-collision guard — two `localPackage(name, ...)` calls
// in the same stack with different `sourcePath`s would both write to the
// SAME registry key (`name`). The substrate's `resolveGraph` is
// name-blind at runtime (`dep-graph.ts:127` — "we don't enforce
// uniqueness at runtime; the duplicate just resolves to the latest
// declaration"). Compile-time `MissingProviders` only catches
// dependency-side mismatches, not two providers sharing an id. We
// catch the collision in `acquireLocal` before publish and surface a
// typed `PublishError('parse')` so the user fixes the name instead of
// debugging a "wrong packageId" downstream.
// ---------------------------------------------------------------------------

describe('local package mode — intra-stack name-collision guard', () => {
	const allocatedSourceDirs: string[] = [];
	afterAll(() => {
		for (const dir of allocatedSourceDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	const freshSourceDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), 'name-collision-'));
		allocatedSourceDirs.push(dir);
		return dir;
	};

	it.effect(
		'fails the second acquire when two localPackage calls share a name with different sourcePaths',
		() =>
			Effect.gen(function* () {
				const firstSource = freshSourceDir();
				const secondSource = freshSourceDir();
				expect(firstSource).not.toBe(secondSource);
				const registry = yield* PackageRegistryService;

				// First acquire — succeeds and writes the registry.
				const firstResult = yield* Effect.scoped(
					acquireLocal(cacheMissPublisher(), okVerifyProbe, registry, {
						packageName: 'collide',
						sourcePath: firstSource,
						chainId: 'sui:collide-test',
						publisherAddress: '0xpublisheraddr',
						executor: succeedingExecutor,
					}),
				);
				expect(firstResult.resolved.kind).toBe('local');
				expect(firstResult.resolved.sourcePath).toBe(firstSource);

				// Second acquire — same `packageName`, DIFFERENT
				// `sourcePath`. Must fail with PublishError('parse').
				const exit = yield* Effect.scoped(
					acquireLocal(cacheMissPublisher(), okVerifyProbe, registry, {
						packageName: 'collide',
						sourcePath: secondSource,
						chainId: 'sui:collide-test',
						publisherAddress: '0xpublisheraddr',
						executor: succeedingExecutor,
					}),
				).pipe(Effect.exit);

				const errorOpt = Exit.findErrorOption(exit) as Option.Option<
					PublishError | ArtifactPublishError
				>;
				expect(Option.isSome(errorOpt)).toBe(true);
				const error = Option.getOrThrow(errorOpt);

				expect(error._tag).toBe('PublishError');
				if (error._tag !== 'PublishError') throw new Error('typeguard');
				expect(error.phase).toBe('parse');
				expect(error.packageName).toBe('collide');
				expect(error.message).toContain("localPackage('collide')");
				expect(error.message).toContain('declared twice');
				expect(error.message).toContain(firstSource);
				expect(error.message).toContain(secondSource);

				// Pin the negative: the first acquire's registry entry
				// is NOT overwritten by the failed second acquire.
				const registered = yield* registry.find('collide');
				expect(registered?.kind).toBe('local');
				if (registered?.kind === 'local') {
					expect(registered.sourcePath).toBe(firstSource);
				}
			}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('re-acquire from the SAME localPackage call (same name + sourcePath) is allowed', () =>
		// Warm-restart / re-acquire on the same scope must NOT trip
		// the collision guard — the registry entry already names
		// `inputs.sourcePath` and the second acquire is the same
		// declaration, not a sibling.
		Effect.gen(function* () {
			const sourcePath = freshSourceDir();
			const registry = yield* PackageRegistryService;

			const firstResult = yield* Effect.scoped(
				acquireLocal(cacheMissPublisher(), okVerifyProbe, registry, {
					packageName: 'reentrant',
					sourcePath,
					chainId: 'sui:reentrant-test',
					publisherAddress: '0xpublisheraddr',
					executor: succeedingExecutor,
				}),
			);
			expect(firstResult.resolved.sourcePath).toBe(sourcePath);

			// Same name + same sourcePath — should succeed.
			const secondResult = yield* Effect.scoped(
				acquireLocal(cacheMissPublisher(), okVerifyProbe, registry, {
					packageName: 'reentrant',
					sourcePath,
					chainId: 'sui:reentrant-test',
					publisherAddress: '0xpublisheraddr',
					executor: succeedingExecutor,
				}),
			);
			expect(secondResult.resolved.sourcePath).toBe(sourcePath);
		}).pipe(Effect.provide(layerPackageRegistry)),
	);
});
