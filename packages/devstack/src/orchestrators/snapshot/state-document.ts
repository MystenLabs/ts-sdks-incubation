import { Effect, FileSystem, Schema } from 'effect';

import {
	StateDocument as StateDocumentSchema,
	type StateDocument,
} from '../../substrate/runtime/state-store/index.ts';

export const readSnapshotStateDocument = (
	path: string,
): Effect.Effect<StateDocument, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch((cause) => Effect.fail(new Error(`read ${path} failed`, { cause }))));
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) => new Error(`${path} is not valid JSON`, { cause }),
		});
		return yield* Schema.decodeUnknownEffect(StateDocumentSchema)(raw).pipe(
			Effect.catch((cause) =>
				Effect.fail(new Error(`${path} failed StateDocument schema decode`, { cause })),
			),
		);
	});

export const writeSnapshotStateDocument = (
	path: string,
	doc: StateDocument,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.writeFileString(path, `${JSON.stringify(doc, null, 2)}\n`)
			.pipe(Effect.catch((cause) => Effect.fail(new Error(`write ${path} failed`, { cause }))));
	});
