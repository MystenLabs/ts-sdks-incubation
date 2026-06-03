// B.1 load-bearing guard — ctx.persist id/path parity.
//
// `ctx.persist` is a THIN pass-through to the Cache primitive's
// `publish` (the folded-in artifact-publisher cycle): it forwards the
// plugin-supplied HEX `spec.chain` VERBATIM
// (the substrate does NOT fold `identity.chain`). The on-disk cache —
// and therefore warm-restart id stability + private-content
// decryptability — keys on `(namespace, chain, contentHash)`. If a
// well-meaning refactor ever folded `identity.chain` into `ctx.persist`,
// every on-disk artifact would be orphaned and warm restarts would
// re-deploy with fresh ids.
//
// This test proves, against the REAL cache + path resolver:
//   1. `ctx.persist(spec)` writes the cache entry at exactly the path
//      `paths.cacheEntry(namespace, hexChain, contentHash)` predicts —
//      i.e. it keys on the hex chain id passed in the spec, NOT the
//      identity's raw chain string.
//   2. A SECOND publish for the identical spec (here via the direct
//      `CacheService.publish`, which is byte-for-byte what
//      `ctx.persist` delegates to) is a WARM HIT: `produce` does NOT run
//      again, and the same `Produced` is returned.
//
// `ctx.persist` is constructed exactly as the supervisor builds it
// (`acquire-node.ts` `makePluginCtx`): `(spec) => publisher.publish(spec)`.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer, Ref } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';

import type { ArtifactPublisher, ArtifactSpec } from '../../src/primitives/artifact-publisher.ts';
import { CacheService, layerCache } from '../../src/substrate/runtime/cache/index.ts';
import {
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
	StackPathsService,
} from '../../src/substrate/runtime/paths.ts';
import { appName, chainId, contentHash, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';

// The identity's chain is the RAW network string. The spec's chain is
// the HEX on-chain id a real plugin reads off `sui.chain`. They DIFFER
// on purpose — the parity assertion below proves persist keys on the
// hex spec.chain, never the raw identity.chain.
const RAW_IDENTITY_CHAIN = 'sui:local';
const HEX_SPEC_CHAIN = '35834a8a';

const identity: Identity = {
	app: appName('persist-parity-app'),
	stack: stackName('persist-parity-stack'),
	chain: chainId(RAW_IDENTITY_CHAIN),
};

interface CachedArtifact {
	readonly objectId: string;
	readonly value: number;
}

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'persist-id-parity-'));
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const substrateLayer = (runtimeRoot: string): Layer.Layer<CacheService | StackPathsService> =>
	layerCache.pipe(
		Layer.provideMerge(layerStackPaths),
		Layer.provideMerge(
			Layer.mergeAll(
				layerIdentity(identity),
				layerRuntimeRoot(runtimeRoot),
				NodePath.layer,
				NodeFileSystem.layer,
			),
		),
	);

describe('ctx.persist id/path parity (B.1)', () => {
	it.effect('persist keys on hex spec.chain; warm second publish is a hit (no re-produce)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const produceRuns = yield* Ref.make(0);
				const registerRuns = yield* Ref.make(0);

				const produced: CachedArtifact = { objectId: '0xdeadbeef', value: 42 };

				const makeSpec = (): ArtifactSpec<CachedArtifact, true> => ({
					namespace: 'parity-ns',
					// HEX chain id — exactly what a real plugin forwards from
					// `sui.chain`. Distinct from identity.chain (raw string).
					chain: chainId(HEX_SPEC_CHAIN),
					contentHash: contentHash('abc123content'),
					verify: () => Effect.succeed(true as const),
					produce: Effect.gen(function* () {
						yield* Ref.update(produceRuns, (n) => n + 1);
						return produced;
					}),
					register: () => Ref.update(registerRuns, (n) => n + 1),
				});

				const publisher: ArtifactPublisher = yield* CacheService;
				const paths = yield* StackPathsService;

				// `ctx.persist` is, byte-for-byte, what the supervisor builds in
				// acquire-node.ts makePluginCtx: a thin delegate to the
				// ArtifactPublisher primitive that forwards spec.chain verbatim.
				const ctxPersist: ArtifactPublisher['publish'] = (spec) => publisher.publish(spec);

				// 1. Cold publish via ctx.persist → miss → produce → write.
				const first = yield* ctxPersist(makeSpec());
				expect(first).toEqual(produced);
				expect(yield* Ref.get(produceRuns)).toBe(1);
				expect(yield* Ref.get(registerRuns)).toBe(1);

				// The cache entry must land at the path the resolver predicts
				// from the HEX spec.chain — NOT the raw identity.chain.
				const hexPath = paths.cacheEntry('parity-ns', HEX_SPEC_CHAIN, 'abc123content');
				const rawPath = paths.cacheEntry('parity-ns', RAW_IDENTITY_CHAIN, 'abc123content');
				expect(existsSync(hexPath.file)).toBe(true);
				expect(existsSync(rawPath.file)).toBe(false);

				// Sanity: the written payload round-trips the produced artifact.
				const onDisk = JSON.parse(readFileSync(hexPath.file, 'utf8')) as {
					readonly bytes: string;
				};
				const decoded = JSON.parse(
					Buffer.from(onDisk.bytes, 'base64').toString('utf8'),
				) as CachedArtifact;
				expect(decoded).toEqual(produced);

				// 2. Direct CacheService.publish for the IDENTICAL
				//    spec → warm HIT: verify returns non-null, so produce does
				//    NOT run again; register fires every cycle. The path the
				//    second call reads is identical to the first.
				const second = yield* publisher.publish(makeSpec());
				expect(second).toEqual(produced);
				expect(yield* Ref.get(produceRuns)).toBe(1); // still 1 — no re-produce
				expect(yield* Ref.get(registerRuns)).toBe(2); // fired again on hit

				// Path the direct publish keyed on === path ctx.persist wrote.
				const hexPathAgain = paths.cacheEntry('parity-ns', HEX_SPEC_CHAIN, 'abc123content');
				expect(hexPathAgain.file).toBe(hexPath.file);
			}),
		).pipe(Effect.provide(substrateLayer(root))),
	);
});
