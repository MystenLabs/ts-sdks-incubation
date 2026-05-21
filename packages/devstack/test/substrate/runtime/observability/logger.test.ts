// Logger service tests.
//
// Architecture invariants under test:
//   1. Per-tag ring buffer: writes past `DEFAULT_MAX_LINES_PER_TAG`
//      drop the oldest line and flip `truncated: true`.
//   2. `MAX_LINE_BYTES` cap: oversized messages are truncated with the
//      `…[truncated]` suffix at write time.
//   3. Buffer entries record `level` verbatim from the payload — the
//      closed level vocabulary round-trips through the buffer.
//   4. `readTag` for an unknown tag returns the empty snapshot.
//   5. `readAll` exposes every recorded tag's snapshot.
//   6. `clearTag` drops the tag entirely; a subsequent `log` for the
//      same tag re-creates a fresh buffer with `truncated: false`.
//   7. The Effect-logger bridge per-level cases (`trace`/`debug`/
//      `info`/`warn`/`error`/`fatal`) are exercised without diverting
//      the buffer write.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	DEFAULT_MAX_LINES_PER_TAG,
	Logger,
	MAX_LINE_BYTES,
	layerLogger,
	type LogLevel,
} from '../../../../src/substrate/runtime/observability/logger.ts';
import { pluginKey } from '../../../../src/substrate/brand.ts';

describe('Logger', () => {
	it.effect('records a single line under the requested tag with the payload level', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('alpha', pluginKey('plug-a'), {
				level: 'info',
				message: 'hello',
				fields: { who: 'world' },
			});
			const buf = yield* logger.readTag('alpha');
			expect(buf.lines.length).toBe(1);
			expect(buf.lines[0]!.tag).toBe('alpha');
			expect(buf.lines[0]!.pluginKey).toBe(pluginKey('plug-a'));
			expect(buf.lines[0]!.level).toBe('info');
			expect(buf.lines[0]!.message).toBe('hello');
			expect(buf.lines[0]!.fields).toEqual({ who: 'world' });
			expect(buf.truncated).toBe(false);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('readTag for an unknown tag returns the empty snapshot', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const buf = yield* logger.readTag('never-written');
			expect(buf.lines).toEqual([]);
			expect(buf.truncated).toBe(false);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('ring buffer drops the oldest line past DEFAULT_MAX_LINES_PER_TAG', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const overflow = 5;
			const total = DEFAULT_MAX_LINES_PER_TAG + overflow;
			for (let i = 0; i < total; i++) {
				yield* logger.log('ring', null, {
					level: 'info',
					message: `line-${i}`,
				});
			}
			const buf = yield* logger.readTag('ring');
			expect(buf.lines.length).toBe(DEFAULT_MAX_LINES_PER_TAG);
			expect(buf.truncated).toBe(true);
			// First retained line is the (overflow)th write — oldest
			// `overflow` lines were dropped.
			expect(buf.lines[0]!.message).toBe(`line-${overflow}`);
			expect(buf.lines[buf.lines.length - 1]!.message).toBe(`line-${total - 1}`);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('truncated flag stays sticky across subsequent in-bound writes', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			for (let i = 0; i < DEFAULT_MAX_LINES_PER_TAG + 1; i++) {
				yield* logger.log('sticky', null, { level: 'info', message: `${i}` });
			}
			const afterOverflow = yield* logger.readTag('sticky');
			expect(afterOverflow.truncated).toBe(true);
			// Drop the tag, then write one line: a fresh buffer must not
			// inherit `truncated` from the previous incarnation.
			yield* logger.clearTag('sticky');
			yield* logger.log('sticky', null, { level: 'info', message: 'fresh' });
			const afterClear = yield* logger.readTag('sticky');
			expect(afterClear.truncated).toBe(false);
			expect(afterClear.lines.length).toBe(1);
			expect(afterClear.lines[0]!.message).toBe('fresh');
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('messages over MAX_LINE_BYTES are truncated with the suffix', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const huge = 'x'.repeat(MAX_LINE_BYTES + 200);
			yield* logger.log('big', null, { level: 'info', message: huge });
			const buf = yield* logger.readTag('big');
			expect(buf.lines.length).toBe(1);
			const recorded = buf.lines[0]!.message;
			expect(recorded.length).toBe(MAX_LINE_BYTES + '…[truncated]'.length);
			expect(recorded.endsWith('…[truncated]')).toBe(true);
			expect(recorded.slice(0, 16)).toBe('x'.repeat(16));
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('messages at exactly MAX_LINE_BYTES are not truncated', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const exact = 'y'.repeat(MAX_LINE_BYTES);
			yield* logger.log('edge', null, { level: 'info', message: exact });
			const buf = yield* logger.readTag('edge');
			expect(buf.lines[0]!.message.length).toBe(MAX_LINE_BYTES);
			expect(buf.lines[0]!.message.endsWith('…[truncated]')).toBe(false);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('readAll exposes every recorded tag', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('a', null, { level: 'info', message: '1' });
			yield* logger.log('b', null, { level: 'warn', message: '2' });
			yield* logger.log('c', null, { level: 'error', message: '3' });
			const all = yield* logger.readAll;
			expect(new Set(all.keys())).toEqual(new Set(['a', 'b', 'c']));
			expect(all.get('a')!.lines[0]!.message).toBe('1');
			expect(all.get('b')!.lines[0]!.level).toBe('warn');
			expect(all.get('c')!.lines[0]!.level).toBe('error');
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('clearTag drops the tag entry from readAll', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('drop', null, { level: 'info', message: 'first' });
			yield* logger.log('keep', null, { level: 'info', message: 'first' });
			yield* logger.clearTag('drop');
			const all = yield* logger.readAll;
			expect(all.has('drop')).toBe(false);
			expect(all.has('keep')).toBe(true);
			// Re-asking the buffer directly returns the empty snapshot.
			const dropped = yield* logger.readTag('drop');
			expect(dropped.lines).toEqual([]);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('clearTag on an unknown tag is a no-op', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('present', null, { level: 'info', message: 'x' });
			yield* logger.clearTag('absent');
			const all = yield* logger.readAll;
			expect(all.has('present')).toBe(true);
			expect(all.has('absent')).toBe(false);
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('every closed level is recorded verbatim in the buffer entry', () =>
		// The Effect-logger bridge has a closed switch over the
		// `LogLevel` literal vocabulary. Walking the closed set proves
		// (a) the buffer round-trips each variant and (b) the bridge's
		// per-level dispatch doesn't throw or short-circuit the
		// buffer write.
		Effect.gen(function* () {
			const logger = yield* Logger;
			const levels: ReadonlyArray<LogLevel> = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
			for (const level of levels) {
				yield* logger.log(`level-${level}`, null, {
					level,
					message: `at ${level}`,
				});
			}
			for (const level of levels) {
				const buf = yield* logger.readTag(`level-${level}`);
				expect(buf.lines.length).toBe(1);
				expect(buf.lines[0]!.level).toBe(level);
				expect(buf.lines[0]!.message).toBe(`at ${level}`);
			}
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('absent fields default to the empty record on the buffered line', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('no-fields', null, { level: 'info', message: 'plain' });
			const buf = yield* logger.readTag('no-fields');
			expect(buf.lines[0]!.fields).toEqual({});
		}).pipe(Effect.provide(layerLogger)),
	);

	it.effect('null pluginKey is preserved on the buffered line', () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			yield* logger.log('null-key', null, { level: 'info', message: 'x' });
			yield* logger.log('with-key', pluginKey('plug-x'), {
				level: 'info',
				message: 'y',
			});
			const a = yield* logger.readTag('null-key');
			const b = yield* logger.readTag('with-key');
			expect(a.lines[0]!.pluginKey).toBe(null);
			expect(b.lines[0]!.pluginKey).toBe(pluginKey('plug-x'));
		}).pipe(Effect.provide(layerLogger)),
	);
});
