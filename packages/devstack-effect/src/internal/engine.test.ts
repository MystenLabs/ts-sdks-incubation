// Engine focuses on a tiny set of state transitions over a Ref of
// `TuiState`. Most of the surface is covered by the ink component tests
// (which render the resolved state via the production engine). The
// transitions we lock down here are the ones that are easy to break in
// isolation: phase narration + the implicit clear-on-terminal logic that
// keeps `(running genesis)` from sticking to a `ready` row.

import { Cause, Context, Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EngineHandle, EngineLive, type EngineHandleShape } from './engine.js';
import { DockerError, PublishError } from '../primitives/errors.js';
import { SuiCliError } from './sui-cli.js';

const buildEngine = (): Effect.Effect<EngineHandleShape> =>
	Effect.gen(function* () {
		const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
		return Context.get(ctx, EngineHandle);
	});

describe('EngineHandle.setPhase', () => {
	it.effect('updates the entry\'s phase while it is acquiring', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'starting container');

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'sui.localnet');
			expect(entry?.phase).toBe('starting container');
			expect(entry?.status).toBe('acquiring');
		}),
	);

	it.effect('overwrites prior phase on subsequent calls', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'building image');
			yield* engine.setPhase('sui.localnet', 'running genesis');

			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries[0]?.phase).toBe('running genesis');
		}),
	);

	it.effect('clears phase automatically on transition to ready', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'awaiting rpc');
			yield* engine.markReady('sui.localnet', {
				title: 'sui.localnet',
				primary: 'http://127.0.0.1:9000',
			});

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries[0];
			expect(entry?.status).toBe('ready');
			expect(entry?.phase).toBeUndefined();
		}),
	);

	it.effect('clears phase automatically on transition to failed', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'accounts.alice', kind: 'action' }]);
			yield* engine.markAcquiring('accounts.alice', 'action');
			yield* engine.setPhase('accounts.alice', 'requesting funds');
			yield* engine.markFailed('accounts.alice', Cause.fail(new Error('faucet 503')));

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries[0];
			expect(entry?.status).toBe('failed');
			expect(entry?.phase).toBeUndefined();
			expect(entry?.error).toContain('faucet 503');
		}),
	);

	it.effect('is a noop for unknown keys (no auto-register)', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.setPhase('phantom', 'starting');
			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries.length).toBe(0);
		}),
	);
});

describe('EngineHandle.notifyChangedTags watch-event attribution', () => {
	// The watcher fiber calls `notifyChangedTags` BEFORE `requestRestart`
	// so the next cycle's launch can read the Ref to surface which
	// primitive(s) triggered this restart. The Ref de-dupes across
	// repeated notifications (e.g. two debounced events on overlapping
	// paths) and clears on `resetRestartSignal` so each cycle starts
	// with fresh attribution.

	it.effect('accumulates de-duped tag keys across multiple notify calls', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.notifyChangedTags(['bindings.hello', 'publish.hello']);
			const tags = yield* Ref.get(engine.changedTags);
			// Set-merge order isn't guaranteed; assert membership instead.
			expect([...tags].sort()).toEqual(['bindings.hello', 'publish.hello']);
		}),
	);

	it.effect('clears on resetRestartSignal so each cycle starts fresh', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.resetRestartSignal;
			const tags = yield* Ref.get(engine.changedTags);
			expect(tags).toEqual([]);
		}),
	);

	it.effect('an empty notify is a noop (existing attribution preserved)', () =>
		Effect.gen(function* () {
			// A watcher fiber that hashes a directory event (no `__watchPaths`
			// match) skips notify entirely — pinning this so a future refactor
			// that always calls notify with []`empty doesn't accidentally
			// clobber a prior cycle's attribution.
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.notifyChangedTags([]);
			const tags = yield* Ref.get(engine.changedTags);
			expect(tags).toEqual(['publish.hello']);
		}),
	);
});

describe('EngineHandle.markFailed root-cause extraction', () => {
	it.effect('walks the cause chain to the innermost message for the row summary', () =>
		// The outer wrapper's message is the same generic preamble for every
		// publish failure ('publishMove(...): build failed'); the user needs
		// to see the sui-cli's actual reason ('unexpected argument...'). The
		// engine row pulls the deepest message off the cause chain so the
		// 60-char budget surfaces the root cause instead of the wrapper.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'publish.demo', kind: 'action' }]);
			const root = new SuiCliError({
				op: 'sui move build',
				message: "sui move build exited 2: error: unexpected argument '--json' found",
			});
			const wrapped = new PublishError({
				stage: 'build',
				message: 'publishMove(demo): build failed',
				cause: root,
			});
			yield* engine.markFailed('publish.demo', Cause.fail(wrapped));
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'publish.demo');
			expect(entry?.error).toContain("unexpected argument '--json' found");
			expect(entry?.error).not.toContain('publishMove(demo): build failed');
		}),
	);

	it.effect('prefers tagged-error stderr over message when both are present', () =>
		// DockerError carries the cli's verbatim stderr in `stderr` and a
		// short summary in `message`. The row's job is to surface the real
		// stderr line (the daemon's actual error) — that's what the user
		// has to copy into a search engine.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			const docker = new DockerError({
				op: 'docker run',
				message: 'docker run — exit 125',
				stderr: 'Error response from daemon: pull access denied',
				exitCode: 125,
			});
			yield* engine.markFailed('sui.localnet', Cause.fail(docker));
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'sui.localnet');
			expect(entry?.error).toContain('pull access denied');
		}),
	);
});
