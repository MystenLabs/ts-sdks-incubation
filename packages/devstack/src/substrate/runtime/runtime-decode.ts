import { Effect, Schema } from 'effect';

export interface RuntimeDecodeIssue {
	readonly source: string;
	readonly message: string;
	readonly cause?: unknown;
}

export type RuntimeDecodeErrorFactory<E> = (issue: RuntimeDecodeIssue) => E;

export interface DecodeOptions<E> {
	readonly source: string;
	readonly mkError: RuntimeDecodeErrorFactory<E>;
	readonly message?: string;
}

export interface JsonArrayElementDecodeOptions<E> extends DecodeOptions<E> {
	readonly index?: number;
	readonly missingMessage?: string;
}

const issue = <E>(
	options: DecodeOptions<E>,
	message: string,
	cause?: unknown,
): RuntimeDecodeIssue => ({
	source: options.source,
	message: options.message ?? message,
	...(cause === undefined ? {} : { cause }),
});

export const parseJsonText = <E>(
	text: string,
	options: DecodeOptions<E>,
): Effect.Effect<unknown, E> =>
	Effect.try({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) => options.mkError(issue(options, 'failed to parse JSON', cause)),
	});

export const parseJsonTextSync = <E>(text: string, options: DecodeOptions<E>): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw options.mkError(issue(options, 'failed to parse JSON', cause));
	}
};

export const decodeUnknown = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	value: unknown,
	options: DecodeOptions<E>,
): Effect.Effect<S['Type'], E> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((cause) => options.mkError(issue(options, 'failed to decode value', cause))),
	);

export const decodeUnknownSync = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	value: unknown,
	options: DecodeOptions<E>,
): S['Type'] => {
	try {
		return Schema.decodeUnknownSync(schema)(value);
	} catch (cause) {
		throw options.mkError(issue(options, 'failed to decode value', cause));
	}
};

export const decodeJsonText = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	text: string,
	options: DecodeOptions<E>,
): Effect.Effect<S['Type'], E> =>
	parseJsonText(text, options).pipe(
		Effect.flatMap((value) => decodeUnknown(schema, value, options)),
	);

export const decodeJsonTextSync = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	text: string,
	options: DecodeOptions<E>,
): S['Type'] => decodeUnknownSync(schema, parseJsonTextSync(text, options), options);

export const decodeJsonArrayElementSync = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	text: string,
	options: JsonArrayElementDecodeOptions<E>,
): S['Type'] => {
	const index = options.index ?? 0;
	const value = parseJsonTextSync(text, options);
	if (!Array.isArray(value) || value[index] === undefined) {
		throw options.mkError(
			issue(
				options,
				options.missingMessage ?? `expected JSON array element at index ${index}`,
				value,
			),
		);
	}
	return decodeUnknownSync(schema, value[index], options);
};

export const decodeJsonLines = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	text: string,
	options: DecodeOptions<E>,
): Effect.Effect<ReadonlyArray<S['Type']>, E> =>
	Effect.forEach(
		text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line.length > 0),
		(line, index) =>
			decodeJsonText(schema, line, {
				...options,
				source: `${options.source}:${index + 1}`,
			}),
	);
