// Coverage for `TuiLoggerLayer` — the bridge that pulls `Effect.log*`
// into `engine.appendLog` so they end up in the same Ref the ink
// `<Static>` component renders from. Without this, log calls would
// race the ink frame writes and tear the layout.

import { Effect, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EngineHandle, EngineLive } from '../internal/engine.js';
import { TuiLoggerLayer } from './index.js';

describe('TuiLoggerLayer', () => {
	it.effect('routes Effect.log* into engine.appendLog so the renderer can pick them up', () =>
		Effect.gen(function* () {
			const engine = yield* EngineHandle;

			yield* Effect.logInfo('hello tui').pipe(Effect.provide(TuiLoggerLayer(engine)));
			yield* Effect.logError('something bad').pipe(Effect.provide(TuiLoggerLayer(engine)));

			const state = yield* Ref.get(engine.tuiState);
			const messages = state.logs.map((l) => l.message);
			expect(messages).toContain('hello tui');
			expect(messages).toContain('something bad');

			const error = state.logs.find((l) => l.message === 'something bad');
			expect(error?.level).toBe('Error');
		}).pipe(Effect.provide(EngineLive)),
	);
});
