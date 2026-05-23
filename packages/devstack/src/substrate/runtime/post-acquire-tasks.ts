import { Context, Data, Effect, Layer, Ref, Scope } from 'effect';

import type { PluginKey } from '../brand.ts';

export interface PostAcquireTask {
	readonly pluginKey: PluginKey;
	readonly label: string;
	readonly run: Effect.Effect<void, unknown, Scope.Scope>;
}

export class PostAcquireTaskFailed extends Data.TaggedError('PostAcquireTaskFailed')<{
	readonly pluginKey: PluginKey;
	readonly label: string;
	readonly cause: unknown;
}> {}

export interface PostAcquireTasksShape {
	readonly register: (task: PostAcquireTask) => Effect.Effect<void, never, Scope.Scope>;
	readonly runAll: Effect.Effect<void, PostAcquireTaskFailed, never>;
}

export class PostAcquireTasksService extends Context.Service<
	PostAcquireTasksService,
	PostAcquireTasksShape
>()('@devstack-rewrite/substrate/PostAcquireTasks') {}

interface RegisteredPostAcquireTask extends PostAcquireTask {
	readonly id: symbol;
	readonly scope: Scope.Scope;
}

export const layerPostAcquireTasks: Layer.Layer<PostAcquireTasksService> = Layer.effect(
	PostAcquireTasksService,
	Effect.gen(function* () {
		const tasksRef = yield* Ref.make<ReadonlyArray<RegisteredPostAcquireTask>>([]);

		const register = (task: PostAcquireTask): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				const id = Symbol(task.label);
				const registered: RegisteredPostAcquireTask = { ...task, id, scope };
				yield* Ref.update(tasksRef, (tasks) => [...tasks, registered]);
				yield* Effect.addFinalizer(() =>
					Ref.update(tasksRef, (tasks) => tasks.filter((candidate) => candidate.id !== id)),
				);
			});

		const runAll: Effect.Effect<void, PostAcquireTaskFailed, never> = Effect.gen(function* () {
			const tasks = yield* Ref.get(tasksRef);
			for (const task of tasks) {
				yield* Scope.provide(task.run, task.scope).pipe(
					Effect.mapError(
						(cause) =>
							new PostAcquireTaskFailed({
								pluginKey: task.pluginKey,
								label: task.label,
								cause,
							}),
					),
				);
			}
		});

		return PostAcquireTasksService.of({ register, runAll });
	}),
);
