// Lossless BigInt JSON codec. BigInts round-trip through a tagged shape
// `{ __bigint: "<string>" }` so revivers can distinguish them from
// regular strings (a naive `bigint.toString()` replacer is one-way).

export const jsonBigintReplacer = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? { __bigint: value.toString() } : value;

export const jsonBigintReviver = (_key: string, value: unknown): unknown => {
	if (
		typeof value === 'object' &&
		value !== null &&
		'__bigint' in value &&
		typeof (value as { __bigint: unknown }).__bigint === 'string'
	) {
		// `BigInt('foo')` throws — and pre-fix, the throw bubbled out of
		// JSON.parse and the caller silently rewrote the entire state file
		// to an empty payload, masking the corruption. Catch the failure
		// here, leave the tagged shape untouched, and let downstream
		// validators decide what to do (most just ignore unknown shapes;
		// nothing relies on a malformed `__bigint` blob being silently
		// dropped).
		try {
			return BigInt((value as { __bigint: string }).__bigint);
		} catch {
			return value;
		}
	}
	return value;
};
