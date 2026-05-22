// Unit tests for `bootstrap-assets/cargo-image.ts::resolveSealCargoImage`.
//
// The resolver dispatches between two paths:
//   (a) `SEAL_CARGO_IMAGE_OVERRIDE` set → trust-the-tag shortcut.
//   (b) Real `runtime.ensureImage({ contextPath, dockerfile, buildArgs })`
//        against the vendored Dockerfile.
//
// We test (a) here because it's pure (no docker daemon needed); (b)
// is exercised by the `seal-real-boot.test.ts` e2e suite which gates
// on docker availability + the network fetch.
//
// Lives at `test/plugins/seal/cargo-image.test.ts` per the mirror-src/
// rule.

import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
	ContainerBuildContext,
	ContainerRuntime,
	ImageRef,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_SEAL_RUST_TOOLCHAIN,
	resolveDefaultSealCargoImage,
	resolveSealCargoImage,
} from '../../../src/plugins/seal/bootstrap-assets/cargo-image.ts';
import {
	DEFAULT_SEAL_REPO,
	DEFAULT_SEAL_VERSION,
} from '../../../src/plugins/seal/bootstrap-assets/source-fetch.ts';

/** Minimal `ContainerRuntime` stub: only `ensureImage` matters here.
 *  We use a Spy to capture the build context the resolver passes. */
const makeRuntimeStub = (
	ensureImageImpl: (
		ctx: ContainerBuildContext,
	) => Effect.Effect<ImageRef, { _tag: 'ContainerRuntimeError'; reason: string; detail: string }>,
): ContainerRuntime =>
	({
		ensureImage: ensureImageImpl,
		ensureNetwork: () => Effect.die('not used'),
		ensureContainer: () => Effect.die('not used'),
		exec: () => Effect.die('not used'),
		runOneShot: () => Effect.die('not used'),
		inspectByLabels: () => Effect.die('not used'),
		followLogs: () => Effect.die('not used'),
		pause: () => Effect.die('not used'),
		pauseAndCommit: () => Effect.die('not used'),
		unpause: () => Effect.die('not used'),
		stop: () => Effect.die('not used'),
		sweepOrphans: () => Effect.die('not used'),
	}) as unknown as ContainerRuntime;

describe('resolveSealCargoImage — override fast path', () => {
	const PREV = process.env.SEAL_CARGO_IMAGE_OVERRIDE;

	afterEach(() => {
		if (PREV === undefined) delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
		else process.env.SEAL_CARGO_IMAGE_OVERRIDE = PREV;
	});

	it('returns the override tag verbatim without touching runtime', async () => {
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = 'seal-test-stub:latest';
		const runtime = makeRuntimeStub(() =>
			Effect.die('ensureImage should not be called when override is set'),
		);
		const result = await Effect.runPromise(
			Effect.scoped(resolveDefaultSealCargoImage(runtime)) as Effect.Effect<ImageRef, unknown>,
		);
		expect(result.tag).toBe('seal-test-stub:latest');
		expect(result.digest).toBe('seal-test-stub:latest');
	});

	it('ignores empty override (falls through to build path)', async () => {
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = '';
		let buildCalledWith: ContainerBuildContext | null = null;
		const runtime = makeRuntimeStub((ctx) => {
			buildCalledWith = ctx;
			return Effect.succeed({ digest: 'sha256:built', tag: 'built:latest' });
		});
		const result = await Effect.runPromise(
			Effect.scoped(resolveDefaultSealCargoImage(runtime)) as Effect.Effect<ImageRef, unknown>,
		);
		expect(buildCalledWith).not.toBeNull();
		expect(result.digest).toBe('sha256:built');
	});
});

describe('resolveSealCargoImage — build path passes SEAL_VERSION + Dockerfile', () => {
	const PREV = process.env.SEAL_CARGO_IMAGE_OVERRIDE;

	beforeEach(() => {
		delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
	});

	afterEach(() => {
		if (PREV === undefined) delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
		else process.env.SEAL_CARGO_IMAGE_OVERRIDE = PREV;
	});

	it('passes SEAL_VERSION build-arg + dockerfile + a context dir to runtime.ensureImage', async () => {
		let captured: ContainerBuildContext | null = null;
		const runtime = makeRuntimeStub((ctx) => {
			captured = ctx;
			return Effect.succeed({ digest: 'sha256:test', tag: 'devstack-seal:test' });
		});
		const result = await Effect.runPromise(
			Effect.scoped(
				resolveSealCargoImage(runtime, {
					sealRepo: DEFAULT_SEAL_REPO,
					sealRef: 'seal-v0.7.0',
					rustToolchain: DEFAULT_SEAL_RUST_TOOLCHAIN,
				}),
			) as Effect.Effect<ImageRef, unknown>,
		);
		expect(result.tag).toBe('devstack-seal:test');
		expect(captured).not.toBeNull();
		// contextPath is the shared `images/` dir so the Dockerfile can
		// `COPY` the shared `_shared/signal-forward.sh` snippet; the
		// plugin-specific Dockerfile lives at `seal/Dockerfile` under it.
		expect(captured!.dockerfile).toBe('seal/Dockerfile');
		expect(captured!.buildArgs).toEqual({ SEAL_VERSION: 'seal-v0.7.0' });
		// Sanity: the resolved contextPath points at the vendored
		// `images/` dir. We don't pin the absolute path (varies per
		// dev machine + CI sandbox) but we do confirm it contains the
		// segment.
		expect(captured!.contextPath).toMatch(/images\/?$/);
	});

	it('default resolver uses DEFAULT_SEAL_VERSION', async () => {
		let captured: ContainerBuildContext | null = null;
		const runtime = makeRuntimeStub((ctx) => {
			captured = ctx;
			return Effect.succeed({ digest: 'sha256:test', tag: 'devstack-seal:test' });
		});
		await Effect.runPromise(
			Effect.scoped(resolveDefaultSealCargoImage(runtime)) as Effect.Effect<ImageRef, unknown>,
		);
		expect(captured!.buildArgs).toEqual({ SEAL_VERSION: DEFAULT_SEAL_VERSION });
	});

	it('wraps ensureImage errors as typed SealError', async () => {
		const runtime = makeRuntimeStub(() =>
			Effect.fail({
				_tag: 'ContainerRuntimeError' as const,
				reason: 'image-build-failed',
				detail: 'docker daemon unreachable',
			}),
		);
		const exit = await Effect.runPromiseExit(
			Effect.scoped(resolveDefaultSealCargoImage(runtime)) as Effect.Effect<ImageRef, unknown>,
		);
		expect(exit._tag).toBe('Failure');
	});
});
