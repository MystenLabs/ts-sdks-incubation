import { Effect, FileSystem, Schema } from 'effect';

import {
	StateDocument as StateDocumentSchema,
	type StateDocument,
} from '../../substrate/runtime/state-store/index.ts';

/** Tagged failure raised by snapshot state-document helpers. `kind`
 *  discriminates the failure class so downstream phase classifiers can
 *  branch by tag, not by message substring. */
export class SnapshotStateDocumentError extends Schema.TaggedErrorClass<SnapshotStateDocumentError>()(
	'SnapshotStateDocumentError',
	{
		/**
		 * - `'read'` — filesystem read of the state document file failed.
		 * - `'parse'` — file contents are not valid JSON.
		 * - `'decode'` — JSON parses but does not match `StateDocument`
		 *   schema.
		 * - `'write'` — filesystem write of the state document file failed.
		 */
		kind: Schema.Literals(['read', 'parse', 'decode', 'write']),
		detail: Schema.String,
		path: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const fail = (
	kind: SnapshotStateDocumentError['kind'],
	detail: string,
	path: string,
	cause?: unknown,
): Effect.Effect<never, SnapshotStateDocumentError> =>
	Effect.fail(new SnapshotStateDocumentError({ kind, detail, path, cause }));

export const readSnapshotStateDocument = (
	path: string,
): Effect.Effect<StateDocument, SnapshotStateDocumentError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch((cause) => fail('read', `read ${path} failed`, path, cause)));
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				new SnapshotStateDocumentError({
					kind: 'parse',
					detail: `${path} is not valid JSON`,
					path,
					cause,
				}),
		});
		return yield* Schema.decodeUnknownEffect(StateDocumentSchema)(raw).pipe(
			Effect.catch((cause) =>
				fail('decode', `${path} failed StateDocument schema decode`, path, cause),
			),
		);
	});

export const writeSnapshotStateDocument = (
	path: string,
	doc: StateDocument,
): Effect.Effect<void, SnapshotStateDocumentError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.writeFileString(path, `${JSON.stringify(doc, null, 2)}\n`)
			.pipe(Effect.catch((cause) => fail('write', `write ${path} failed`, path, cause)));
	});
