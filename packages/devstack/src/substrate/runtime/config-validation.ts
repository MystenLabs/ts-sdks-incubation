// Plain shape-check helpers — sync-throw discipline.
//
// Reach for these when you want to assert a single field's shape
// ("port must be a positive integer", "name must be a non-empty
// string") and throw a plugin-tagged `ConfigIssue` if it isn't.
// Each helper takes one value + a `{ field, mkError }` and either
// returns the value or throws. Authors compose them at factory /
// boundary sites.
//
// For compound Schema decode (multi-field shapes, refinements,
// transforms), reach for `decodeUnknownSync(schema, value,
// { source, mkError })` from `runtime-decode.ts` instead.

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
