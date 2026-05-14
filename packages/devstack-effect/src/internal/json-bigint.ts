// Lossless BigInt JSON codec. BigInts round-trip through a tagged shape
// `{ __bigint: "<string>" }` so revivers can distinguish them from
// regular strings (a naive `bigint.toString()` replacer is one-way).

export const jsonBigintReplacer = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? { __bigint: value.toString() } : value;

export const jsonBigintReviver = (_key: string, value: unknown): unknown =>
	typeof value === 'object' &&
	value !== null &&
	'__bigint' in value &&
	typeof (value as { __bigint: unknown }).__bigint === 'string'
		? BigInt((value as { __bigint: string }).__bigint)
		: value;
