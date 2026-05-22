import { Effect, Schema } from 'effect';

export interface ConfigIssue {
	readonly field: string;
	readonly message: string;
	readonly hint?: string;
	readonly cause?: unknown;
}

export type ConfigErrorFactory<E> = (issue: ConfigIssue) => E;

export const defineConfigError =
	<const Tag extends string>(tag: Tag) =>
	(issue: ConfigIssue): ConfigIssue & { readonly _tag: Tag } => ({
		_tag: tag,
		...issue,
	});

interface ValidatorOptions<E> {
	readonly field: string;
	readonly mkError: ConfigErrorFactory<E>;
	readonly message?: string;
	readonly hint?: string;
}

const fail = <E>(mkError: ConfigErrorFactory<E>, issue: ConfigIssue): never => {
	throw mkError(issue);
};

export const expectNonEmptyString = <E>(value: unknown, options: ValidatorOptions<E>): string => {
	if (typeof value === 'string' && value.length > 0) return value;
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? 'must be a non-empty string',
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectOptionalNonEmptyString = <E>(
	value: unknown,
	options: ValidatorOptions<E>,
): string | undefined => {
	if (value === undefined) return undefined;
	return expectNonEmptyString(value, options);
};

export const expectPositiveInteger = <E>(value: unknown, options: ValidatorOptions<E>): number => {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? 'must be a positive integer',
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectOptionalPositiveInteger = <E>(
	value: unknown,
	options: ValidatorOptions<E>,
): number | undefined => {
	if (value === undefined) return undefined;
	return expectPositiveInteger(value, options);
};

export const expectPositiveFiniteNumber = <E>(
	value: unknown,
	options: ValidatorOptions<E>,
): number => {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? 'must be a positive finite number',
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectPort = <E>(value: unknown, options: ValidatorOptions<E>): number => {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535) {
		return value;
	}
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? 'must be an integer between 1 and 65535',
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectOptionalPort = <E>(
	value: unknown,
	options: ValidatorOptions<E>,
): number | undefined => {
	if (value === undefined) return undefined;
	return expectPort(value, options);
};

export const expectStringRecord = <E>(
	value: unknown,
	options: ValidatorOptions<E>,
): Readonly<Record<string, string>> => {
	if (value === undefined) return {};
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return fail(options.mkError, {
			field: options.field,
			message: options.message ?? 'must be an object of string values',
			...(options.hint === undefined ? {} : { hint: options.hint }),
		});
	}
	for (const [key, entry] of Object.entries(value)) {
		if (key.length === 0) {
			return fail(options.mkError, {
				field: options.field,
				message: 'environment variable names must be non-empty',
				...(options.hint === undefined ? {} : { hint: options.hint }),
			});
		}
		if (typeof entry !== 'string') {
			return fail(options.mkError, {
				field: `${options.field}.${key}`,
				message: 'must be a string',
				...(options.hint === undefined ? {} : { hint: options.hint }),
			});
		}
	}
	return value as Readonly<Record<string, string>>;
};

export const expectOneOf = <const Values extends ReadonlyArray<string>, E>(
	value: unknown,
	values: Values,
	options: ValidatorOptions<E>,
): Values[number] => {
	if (typeof value === 'string' && (values as ReadonlyArray<string>).includes(value)) {
		return value as Values[number];
	}
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? `must be one of ${values.map((v) => `'${v}'`).join(', ')}`,
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectNonEmptyArray = <T, E>(
	value: ReadonlyArray<T> | undefined,
	options: ValidatorOptions<E>,
): ReadonlyArray<T> => {
	if (Array.isArray(value) && value.length > 0) return value;
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? 'must be a non-empty array',
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const expectPattern = <E>(
	value: string,
	pattern: RegExp,
	options: ValidatorOptions<E>,
): string => {
	if (pattern.test(value)) return value;
	return fail(options.mkError, {
		field: options.field,
		message: options.message ?? `must match ${pattern.source}`,
		...(options.hint === undefined ? {} : { hint: options.hint }),
	});
};

export const decodeConfig = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	value: unknown,
	options: ValidatorOptions<E>,
): Effect.Effect<S['Type'], E> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((cause) =>
			options.mkError({
				field: options.field,
				message: options.message ?? 'failed to decode config value',
				...(options.hint === undefined ? {} : { hint: options.hint }),
				cause,
			}),
		),
	);

export const decodeConfigSync = <S extends Schema.Decoder<unknown>, E>(
	schema: S,
	value: unknown,
	options: ValidatorOptions<E>,
): S['Type'] => {
	try {
		return Schema.decodeUnknownSync(schema)(value);
	} catch (cause) {
		return fail(options.mkError, {
			field: options.field,
			message: options.message ?? 'failed to decode config value',
			...(options.hint === undefined ? {} : { hint: options.hint }),
			cause,
		});
	}
};
