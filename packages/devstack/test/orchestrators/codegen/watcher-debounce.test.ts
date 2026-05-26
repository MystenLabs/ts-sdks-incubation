// Codegen watcher debounce tests.
//
// Regression for opportunities-backlog #9: the previous watcher
// claimed coalescing via a `Ref<latest>` + tap pattern but actually
// ran one full `runEmitCycle` per source emission. The fix adds a
// real `Stream.debounce(CONTRIBUTION_DEBOUNCE_MS)`. These tests pin
// the contract that a burst of N updates within the window collapses
// to exactly ONE emit invocation.
//
// `it.live` is required because `Stream.debounce` uses the wall
// clock; `it.effect`'s default `TestClock` freezes time and the
// debounce would never fire (STYLE_GUIDE §1, `it.live` rule).

import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Queue, Ref, Stream } from 'effect';

import type { CodegenableDecl } from '../../../src/contracts/codegenable.ts';

import {
	CONTRIBUTION_DEBOUNCE_MS,
	watchContributions,
} from '../../../src/orchestrators/codegen/watcher.ts';

const decl = (name: string): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: name,
	outputPath: `${name}.ts`,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('v', name);
			return ctx.done();
		}),
});

describe('watchContributions — debounce coalescing', () => {
	it.live('two rapid updates within the debounce window produce ONE cycle', () =>
		Effect.gen(function* () {
			const invocations = yield* Ref.make<Array<ReadonlyArray<string>>>([]);
			const queue = yield* Queue.make<ReadonlyArray<CodegenableDecl<string>>>();

			const fiber = yield* Effect.forkChild(
				watchContributions(Stream.fromQueue(queue), (decls) =>
					Ref.update(invocations, (xs) => [...xs, decls.map((d) => d.emitterName)]),
				),
				{ startImmediately: true },
			);

			// Three updates within the debounce window, no gap between
			// them. `Stream.debounce` drops the intermediates and emits
			// only the trailing value after the window elapses idle.
			yield* Queue.offer(queue, [decl('first')]);
			yield* Queue.offer(queue, [decl('first'), decl('second')]);
			yield* Queue.offer(queue, [decl('first'), decl('second'), decl('third')]);

			// Wait longer than the debounce window so the trailing edge
			// fires exactly once.
			yield* Effect.sleep(`${CONTRIBUTION_DEBOUNCE_MS * 4} millis`);
			yield* Fiber.interrupt(fiber);

			const seen = yield* Ref.get(invocations);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toEqual(['first', 'second', 'third']);
		}),
	);

	it.live('updates separated by > debounce window produce one cycle each', () =>
		Effect.gen(function* () {
			const invocations = yield* Ref.make<Array<ReadonlyArray<string>>>([]);
			const queue = yield* Queue.make<ReadonlyArray<CodegenableDecl<string>>>();
			const gap = CONTRIBUTION_DEBOUNCE_MS * 3;

			const fiber = yield* Effect.forkChild(
				watchContributions(Stream.fromQueue(queue), (decls) =>
					Ref.update(invocations, (xs) => [...xs, decls.map((d) => d.emitterName)]),
				),
				{ startImmediately: true },
			);

			yield* Queue.offer(queue, [decl('alpha')]);
			yield* Effect.sleep(`${gap} millis`);
			yield* Queue.offer(queue, [decl('beta')]);
			yield* Effect.sleep(`${gap} millis`);
			yield* Fiber.interrupt(fiber);

			const seen = yield* Ref.get(invocations);
			expect(seen).toHaveLength(2);
			expect(seen[0]).toEqual(['alpha']);
			expect(seen[1]).toEqual(['beta']);
		}),
	);
});
