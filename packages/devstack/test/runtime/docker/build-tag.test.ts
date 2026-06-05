// (app, stack) build-TAG scoping (cross-app image-collapse fix).
//
// The content-addressed `devstack-build:<hash16>` tag is content-ONLY.
// Two stacks with byte-identical build context would otherwise share ONE
// on-host tag; when each commits its writable layer onto that shared name,
// capture/restore's per-container image-promote collapses them
// (last-write-wins) — e.g. app A's sui indexer-db PGDATA gets aliased
// under app B's container ("FATAL: password authentication failed").
//
// Fix (this test): when an owner is present, scope the TAG by (app, stack)
// — `devstack-build:<app>-<stack>-<hash16>` — while keeping the build CACHE
// KEY content-only (`{namespace, chain, contentHash}`), so builds STILL share
// across stacks (no redundant rebuild) and only the on-host TAG differs.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { ContainerBuildContext } from '../../../src/contracts/container-runtime.ts';
import { DockerSpawner, layerDockerHost, type DockerHost } from '../../../src/runtime/docker/client.ts';
import { sanitizeTagSegment } from '../../../src/runtime/docker/labels.ts';
import {
	buildContentHash,
	ContainerRuntimeService,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
} from '../../../src/runtime/docker/service.ts';
import { CacheService } from '../../../src/substrate/runtime/cache/index.ts';
import type { CacheKey } from '../../../src/primitives/cache.ts';
import { stackPathsLayer } from '../../helpers/mock-stack-paths.ts';

const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const fakeDockerLayer = (bin: string): Layer.Layer<DockerHost | DockerSpawner> =>
	Layer.merge(
		layerDockerHost({ bin }),
		layerDockerSpawnerFromNode.pipe(
			Layer.provideMerge(
				NodeChildProcessSpawner.layer.pipe(
					Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
				),
			),
		),
	);

/** `docker` shim that resolves any `image inspect` to a fixed digest so the
 *  on-host short-circuit returns immediately (no real `docker build`); the
 *  resolved `ImageRef.tag` is what we assert on. */
const writeInspectShim = (root: string): string => {
	const bin = join(root, 'docker');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
			'  printf "sha256:deadbeef"',
			'  exit 0',
			'fi',
			'exit 0',
			'',
		].join('\n'),
	);
	chmodSync(bin, 0o755);
	return bin;
};

/** Cache stub recording every `lookup` key; always MISS so the build path's
 *  on-host short-circuit runs (and we can read back the cache key the service
 *  constructed). */
const recordingCacheLayer = (
	keysRef: Ref.Ref<ReadonlyArray<CacheKey>>,
): Layer.Layer<CacheService> =>
	Layer.succeed(CacheService)({
		lookup: (key) => Ref.update(keysRef, (ks) => [...ks, key]).pipe(Effect.as(null)),
		write: () => Effect.void,
		delete: () => Effect.void,
		publish: (spec) => spec.produce,
	});

const dockerRuntimeLayer = (
	bin: string,
	stackRoot: string,
	keysRef: Ref.Ref<ReadonlyArray<CacheKey>>,
): Layer.Layer<ContainerRuntimeService> =>
	layerContainerRuntimeDocker.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				fakeDockerLayer(bin),
				stackPathsLayer(stackRoot),
				layerDockerCycleInitial,
				recordingCacheLayer(keysRef),
			),
		),
	);

const baseCtx = (
	overrides: Partial<ContainerBuildContext> = {},
): ContainerBuildContext => ({
	contextPath: '/tmp/shared-build-ctx',
	dockerfile: 'Dockerfile',
	platform: 'linux/amd64',
	buildArgs: { FOO: 'bar' },
	...overrides,
});

describe('ensureImage — (app, stack) tag scoping', () => {
	it.effect('scopes the tag by (app, stack) when an owner is present', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-tag-owned-'));
			try {
				const bin = writeInspectShim(root);
				const keysRef = yield* Ref.make<ReadonlyArray<CacheKey>>([]);
				const ctx = baseCtx({ owner: { app: 'My App', stack: 'main' } });

				const ref = yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctx);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysRef)));

				const hash16 = buildContentHash(ctx).slice(0, 16);
				expect(ref.tag).toBe(`devstack-build:my-app-main-${hash16}`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('leaves the tag unscoped when no owner is present', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-tag-unowned-'));
			try {
				const bin = writeInspectShim(root);
				const keysRef = yield* Ref.make<ReadonlyArray<CacheKey>>([]);
				const ctx = baseCtx();

				const ref = yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctx);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysRef)));

				const hash16 = buildContentHash(ctx).slice(0, 16);
				expect(ref.tag).toBe(`devstack-build:${hash16}`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('honours an explicit expected.tag unchanged (walrus per-node path)', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-tag-explicit-'));
			try {
				const bin = writeInspectShim(root);
				const keysRef = yield* Ref.make<ReadonlyArray<CacheKey>>([]);
				// Even WITH an owner, an explicit expected.tag wins verbatim —
				// the walrus committee passes `<base>-<pkgid>-node-N` here.
				const ctx = baseCtx({ owner: { app: 'a', stack: 's' } });
				const explicit = 'devstack-build:a-s-deadbeefcafe1234-abc123-node-2';

				const ref = yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctx, { digest: explicit, tag: explicit });
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysRef)));

				expect(ref.tag).toBe(explicit);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('the build CACHE KEY is content-only — shared across (app, stack)', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-tag-cachekey-'));
			try {
				const bin = writeInspectShim(root);
				const keysA = yield* Ref.make<ReadonlyArray<CacheKey>>([]);
				const keysB = yield* Ref.make<ReadonlyArray<CacheKey>>([]);
				const keysNone = yield* Ref.make<ReadonlyArray<CacheKey>>([]);

				// Two DIFFERENT owners, IDENTICAL build content.
				const ctxA = baseCtx({ owner: { app: 'app-a', stack: 'one' } });
				const ctxB = baseCtx({ owner: { app: 'app-b', stack: 'two' } });
				const ctxNone = baseCtx();

				const refA = yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctxA);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysA)));
				const refB = yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctxB);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysB)));
				yield* Effect.gen(function* () {
					const rt = yield* ContainerRuntimeService;
					return yield* rt.ensureImage(ctxNone);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, root, keysNone)));

				// TAGs differ (scoped) — proves no collapse.
				expect(refA.tag).not.toBe(refB.tag);

				const keyA = (yield* Ref.get(keysA))[0]!;
				const keyB = (yield* Ref.get(keysB))[0]!;
				const keyNone = (yield* Ref.get(keysNone))[0]!;

				// CACHE KEY identical across both owners AND the unowned build —
				// content-only, so a build done by one stack is reused by all.
				expect(keyA).toEqual(keyB);
				expect(keyA).toEqual(keyNone);
				expect(keyA).toEqual({
					namespace: 'runtime-docker-build',
					chain: 'n/a',
					contentHash: buildContentHash(ctxA),
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});

describe('sanitizeTagSegment — Docker-tag-safe (app | stack) segments', () => {
	it('lowercases and replaces illegal characters with a single dash', () => {
		expect(sanitizeTagSegment('My App')).toBe('my-app');
		expect(sanitizeTagSegment('UPPER')).toBe('upper');
		expect(sanitizeTagSegment('a/b:c@d')).toBe('a-b-c-d');
		expect(sanitizeTagSegment('a   b')).toBe('a-b');
	});

	it('collapses runs of illegal characters and trims leading/trailing separators', () => {
		expect(sanitizeTagSegment('a___b')).toBe('a___b');
		expect(sanitizeTagSegment('a!!!b')).toBe('a-b');
		expect(sanitizeTagSegment('--lead-trail--')).toBe('lead-trail');
		expect(sanitizeTagSegment('...dots...')).toBe('dots');
		expect(sanitizeTagSegment('_under_')).toBe('under');
	});

	it('keeps the legal Docker-tag alphabet [a-z0-9._-]', () => {
		expect(sanitizeTagSegment('app.v1_2-3')).toBe('app.v1_2-3');
		expect(sanitizeTagSegment('digits-0123456789')).toBe('digits-0123456789');
	});

	it('never produces an empty segment', () => {
		expect(sanitizeTagSegment('')).toBe('unnamed');
		expect(sanitizeTagSegment('@@@')).toBe('unnamed');
		expect(sanitizeTagSegment('  ')).toBe('unnamed');
	});

	it('distinct owners with the same content never collapse to one tag', () => {
		const hash16 = 'deadbeefcafe1234';
		const tagA = `devstack-build:${sanitizeTagSegment('App A')}-${sanitizeTagSegment('main')}-${hash16}`;
		const tagB = `devstack-build:${sanitizeTagSegment('App B')}-${sanitizeTagSegment('main')}-${hash16}`;
		expect(tagA).not.toBe(tagB);
	});
});
