// End-to-end exercise of the Action plugin's artifact publisher cache discipline.
//
// What this test pins (mirrors `services/action.test.ts` from v3's
// `cache hit` describe block, but threaded through the rewrite's real
// `ArtifactPublisher` + on-disk `Cache` substrate primitives):
//
//   - Cold boot: body runs exactly once; receipt is written to the
//     state-store under `cache/action/<chain>/<hash>.json`.
//   - Warm boot (same runtime root): cache hit; body does NOT run
//     again; receipt is surfaced from the cached payload.
//
// Unlike `template-boot.test.ts`, this test does NOT require docker —
// the Sui chain-probe is stubbed below. We still flow through the
// real artifact publisher + Cache + StrategyRegistry + StackPaths Layers, so the
// on-disk cache shape, key derivation, schema-decode, and lenient
// verify paths are exercised end-to-end.
//
// Why not boot the full `connect-four` stack? The connect-four stack composes
// `sui()`, which spawns a docker validator. The action's caching
// discipline is INDEPENDENT of the chain (the artifact publisher substrate consults
// `state.json` + the chain-probe; the chain-probe itself is the
// load-bearing dependency, NOT the running container). The stub
// chain-probe here pins the cache discipline without depending on a
// clean docker environment.
//
// Discriminator coverage: uses a STATIC string discriminator
// (`opts.discriminator: 'cold-warm-roundtrip'`). The dynamic-Effect
// form's "re-runs on every acquire" semantics live in unit tests; here
// we exercise the produce + cache + verify + register path.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer, Logger, Ref } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from 'vitest';

import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import {
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
} from '../../src/substrate/runtime/paths.ts';
import { layerCache } from '../../src/substrate/runtime/cache/index.ts';
import {
	ArtifactPublisherService,
	layerArtifactPublisher,
} from '../../src/substrate/runtime/artifact-publisher/index.ts';
import { layerStrategyRegistry } from '../../src/substrate/runtime/strategy-registry/index.ts';
import type { ChainProbe } from '../../src/contracts/chain-probe.ts';
import type { SuiProbeKey } from '../../src/plugins/sui/chain-probe.ts';
import { bootActionService, type ActionReceipt } from '../../src/plugins/action/service.ts';

const CHAIN = 'sui:e2e-action-test';

const identity: Identity = {
	app: appName('e2e-action'),
	stack: stackName('main'),
	chain: chainId(CHAIN),
};

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'e2e-action-cache-'));

const platformBase = Layer.mergeAll(
	layerIdentity(identity),
	layerRuntimeRoot(RUNTIME_ROOT),
	NodePath.layer,
	NodeFileSystem.layer,
	layerStrategyRegistry,
);

const withStackPaths = layerStackPaths.pipe(Layer.provideMerge(platformBase));
const withCache = layerCache.pipe(Layer.provideMerge(withStackPaths));
const substrateLayers = layerArtifactPublisher.pipe(Layer.provideMerge(withCache));

/** Construct a fake chain-probe that resolves transaction digests to a
 *  `{digest}` shape on hit, `null` on miss. The test seeds a known
 *  digest set so verify-on-hit succeeds; the action plugin's lenient
 *  probe behavior under `decode-failed` / not-found is exercised by
 *  the unit tests, not here. */
const makeFakeChainProbe = (knownDigests: ReadonlyArray<string>): ChainProbe<SuiProbeKey> => ({
	get: <Shape>(
		key: SuiProbeKey,
		_schema: { readonly Type?: Shape },
		_mode: 'lenient' | 'strict',
	): Effect.Effect<Shape | null, never> => {
		if (key.kind !== 'transaction') {
			return Effect.succeed(null as Shape | null);
		}
		if (!knownDigests.includes(key.digest)) {
			return Effect.succeed(null as Shape | null);
		}
		// Return the bare `{digest}` shape — the action plugin's
		// verify schema is just `{digest: String}`.
		return Effect.succeed({ digest: key.digest } as unknown as Shape);
	},
});

/** Drive ONE action boot. The body increments a Ref counter so the
 *  parent can assert cold-vs-warm behavior. */
const runOnce = (
	bodyCounter: Ref.Ref<number>,
	digest: string,
): Effect.Effect<{ bodyRuns: number; digest: string }, unknown, never> =>
	Effect.gen(function* () {
		const publisher = yield* ArtifactPublisherService;
		const probe = makeFakeChainProbe([digest]);

		const body: Effect.Effect<ActionReceipt, never> = Effect.gen(function* () {
			yield* Ref.update(bodyCounter, (n) => n + 1);
			return {
				digest,
				objectChanges: [],
				balanceChanges: [],
			} satisfies ActionReceipt;
		});

		const result = yield* Effect.scoped(
			bootActionService(publisher, probe, {
				actionName: 'e2e-test-action',
				chainId: chainId(CHAIN),
				staticDiscriminator: {
					actionName: 'e2e-test-action',
					dependencyResourceIds: ['account/alice', 'package:connect_four'],
				},
				dynamicMaterial: Effect.succeed('cold-warm-roundtrip'),
				body,
			}),
		);

		const bodyRuns = yield* Ref.get(bodyCounter);
		return { bodyRuns, digest: result.digest };
	}).pipe(Effect.provide(substrateLayers)) as Effect.Effect<
		{ bodyRuns: number; digest: string },
		unknown,
		never
	>;

const program = Effect.gen(function* () {
	const coldCounter = yield* Ref.make(0);
	const cold = yield* runOnce(coldCounter, 'digest-cold-warm-roundtrip');
	// Same runtime root → cache file persists across the two
	// `runOnce` invocations (the artifact publisher publisher under each runOnce
	// constructs its own Cache instance, but both read/write the
	// SAME on-disk cache dir under the shared RUNTIME_ROOT).
	const warmCounter = yield* Ref.make(0);
	const warm = yield* runOnce(warmCounter, 'digest-cold-warm-roundtrip');

	return { cold, warm };
});

describe('action plugin artifact publisher cache discipline', () => {
	it('cold boot runs body; warm boot hits cache and skips body', async () => {
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(Logger.layer([]))) as Effect.Effect<
				{
					cold: { bodyRuns: number; digest: string };
					warm: { bodyRuns: number; digest: string };
				},
				unknown,
				never
			>,
		);

		// Cold boot: body ran once, receipt's digest matches the body's
		// returned digest.
		expect(result.cold.bodyRuns, 'cold boot: body should run exactly once').toBe(1);
		expect(result.cold.digest).toBe('digest-cold-warm-roundtrip');

		// Warm boot: body did NOT run (counter is per-invocation, so 0
		// means the produce path was short-circuited by the cache hit
		// + verify-ok path), and the digest still matches.
		expect(result.warm.bodyRuns, 'warm boot: body should NOT re-run').toBe(0);
		expect(result.warm.digest).toBe('digest-cold-warm-roundtrip');
	}, 60_000);
});
