// Regression test for the SealError unwrap pattern used by the
// key-server probe-timeout error mapper.
//
// Bug fix (review fix phase 22e/Bug 4): `key-server.ts:startKeyServer`'s
// `waitForProbe` mapError previously mapped `ProbeTimeoutError` to
// `sealError('ready', { cause: cause.lastError ?? cause.lastNotReady ?? cause })`.
// If the inner `lastError` was ALREADY a `SealError` (e.g. surfaced
// from an upstream probe that promoted to typed before reaching the
// timeout boundary), this re-wrap produced a two-layer SealError
// chain. The outer `passthroughOrWrap.for<SealError>` in `index.ts`
// strips one layer on the index path, but the direct
// `sealError('ready', …)` build path doesn't — so a caller catching
// the surfaced SealError would chase two layers of the same tag.
//
// The fix introduces `isSealError` (structural predicate on `_tag`)
// and the key-server mapper now checks: if the inner cause is already
// a SealError, return it as-is rather than re-wrap. This keeps the
// cause chain at most one SealError layer deep.
//
// FALSIFIABILITY: the "contract" block below drives the REAL
// `startKeyServer` production path — a stub `ContainerRuntime` whose
// ready-probe `exec` fails (so `waitForProbe` records the failure as
// `ProbeTimeoutError.lastError`) and a 2ms `readyTimeoutMs` so the
// real wall-clock-deadline loop times out after a single attempt.
// The surfaced error is whatever `key-server.ts`'s mapError produces.
// If someone deleted the `isSealError(inner)` unwrap arm, case (a)
// would surface a `sealError('ready', { cause: <SealError> })` (two
// layers) and the assertion `result === innerSealError` would fail.

import { describe, expect, it } from 'vitest';
import { Effect, Exit, Option, Stream } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	ExecResult,
} from '../../../src/contracts/container-runtime.ts';
import { isSealError, sealError, type SealError } from '../../../src/plugins/seal/errors.ts';
import {
	buildKeyServerSpec,
	startKeyServer,
	type KeyServerSpecInputs,
} from '../../../src/plugins/seal/key-server.ts';

describe('isSealError — structural predicate', () => {
	it('returns true for a SealError-shaped value', () => {
		const err: SealError = sealError('ready', { name: 'seal', message: 'probe timed out' });
		expect(isSealError(err)).toBe(true);
	});

	it('returns false for plain Error instances', () => {
		expect(isSealError(new Error('not seal'))).toBe(false);
	});

	it('returns false for null / undefined', () => {
		expect(isSealError(null)).toBe(false);
		expect(isSealError(undefined)).toBe(false);
	});

	it('returns false for objects with a different _tag', () => {
		expect(isSealError({ _tag: 'NotSeal', message: 'x' })).toBe(false);
	});

	it('returns false for primitives', () => {
		expect(isSealError('SealError')).toBe(false);
		expect(isSealError(42)).toBe(false);
		expect(isSealError(true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Real-path harness: drive startKeyServer's actual mapError seam.
// ---------------------------------------------------------------------------

const SPEC_INPUTS: KeyServerSpecInputs = {
	name: 'seal',
	image: { digest: 'sha256:test', tag: 'seal-test:latest' },
	containerName: 'devstack-app-main-seal-seal-key-server',
	labels: { app: 'app', stack: 'main', plugin: 'seal', role: 'key-server' },
	suiNetwork: 'seal-seal-net',
	servicePath: '/tmp/devstack/runtime/seal/seal',
	configFingerprint: 'package=0x7|keyServer=0xabc123|nodeUrl=http://host.docker.internal:9000',
	routedHostname: 'seal.seal.app.localhost',
	routedUrl: 'http://seal.seal.app.localhost',
	// 2ms wall-clock deadline. waitForProbe uses Date.now() for its
	// deadline (real clock, not TestClock), so this runs ONE probe
	// attempt — recording lastError — then the inter-poll sleep is
	// clamped to `max(1, deadline-now)` (~1ms) and the next loop sees
	// remainingMs <= 0 and fails. This is the proven-reliable idiom from
	// substrate/runtime/probes.test.ts ("captures the last non-ready
	// detail on timeout" runs at timeoutMs: 2). The READY_PROBE_INTERVAL
	// (500ms) inside startKeyServer never applies — the clamp caps the
	// sleep at the remaining budget, so the test stays sub-10ms.
	readyTimeoutMs: 2,
};

const FAKE_HANDLE: ContainerHandle = {
	id: 'seal-container-id',
	name: SPEC_INPUTS.containerName,
	imageName: 'seal-test:latest',
	status: 'running',
	ips: [],
	labels: SPEC_INPUTS.labels,
};

/** A `ContainerRuntime` whose ready-probe `exec` ALWAYS fails with
 *  `probeFailure`. `ensureContainer` succeeds so the boot reaches the
 *  ready-probe; every other method dies (unused on this path).
 *
 *  `waitForProbe` records the WHOLE probe failure (this value) as
 *  `lastError` — its identity is what the production mapError inspects
 *  via `isSealError`. The failure value is whatever the test injects;
 *  the `exec` channel is typed `ContainerRuntimeError`, so we widen the
 *  injected value through `unknown` (case (a) deliberately feeds a
 *  SealError-shaped value down the `exec` channel). */
const runtimeWithFailingProbe = (probeFailure: unknown): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.succeed(FAKE_HANDLE),
	exec: (): Effect.Effect<ExecResult, ContainerRuntimeError> =>
		Effect.fail(probeFailure as ContainerRuntimeError),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	inspectImageDigest: () => Effect.die('inspectImageDigest not used'),
	stop: () => Effect.die('stop not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

/** A plain `ContainerRuntimeError` probe failure (NOT a SealError). */
const probeRuntimeError: ContainerRuntimeError = {
	_tag: 'ContainerRuntimeError',
	reason: 'ready-probe-failed',
	detail: 'exec daemon refused',
};

/** Run the REAL startKeyServer to its (always-failing) ready probe and
 *  return the surfaced error the production mapError produced. */
const runStartKeyServerToFailure = (
	probeFailure: unknown,
): Promise<Exit.Exit<{ readonly containerName: string }, SealError>> =>
	Effect.runPromiseExit(
		Effect.scoped(
			startKeyServer(
				runtimeWithFailingProbe(probeFailure),
				buildKeyServerSpec(SPEC_INPUTS),
				'seal',
			),
		),
	);

describe('SealError unwrap-on-probe-timeout — real startKeyServer mapError path', () => {
	it('(a) a SealError surfaced as the probe failure is unwrapped (NOT re-wrapped)', async () => {
		// The probe-attempt failure IS structurally a SealError. waitForProbe
		// stores it as ProbeTimeoutError.lastError; the real mapError reads
		// `cause.lastError`, sees isSealError(inner) === true, and returns it
		// verbatim — a single SealError layer, NOT sealError('ready', { cause }).
		const innerSealError: SealError = sealError('container', {
			name: 'seal',
			message: 'inner — upstream probe already typed',
		});

		const exit = await runStartKeyServerToFailure(innerSealError);

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			// Same reference, same phase, no outer-wrap rewrite, no nested
			// SealError chain. Deleting the unwrap arm makes phase 'ready'
			// and stuffs the inner under `.cause` — both checked below.
			expect(err.value).toBe(innerSealError);
			expect(err.value.phase).toBe('container');
			expect(err.value.message).toContain('upstream probe already typed');
			expect(isSealError(err.value.cause)).toBe(false);
		}
	});

	it('(b) a non-SealError probe failure IS wrapped as sealError(ready, { cause })', async () => {
		// Plain ContainerRuntimeError probe failure: isSealError(inner) is
		// false, so the mapper produces a fresh sealError('ready', …) and
		// threads the raw failure (the ContainerRuntimeError waitForProbe
		// recorded as lastError) through `.cause`.
		const exit = await runStartKeyServerToFailure(probeRuntimeError);

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('SealError');
			expect(err.value.phase).toBe('ready');
			expect(err.value.message).toContain('never became ready');
			// The non-Seal failure is carried verbatim, not collapsed into a
			// nested Seal layer.
			expect(isSealError(err.value.cause)).toBe(false);
			expect(err.value.cause).toBe(probeRuntimeError);
		}
	});
});
