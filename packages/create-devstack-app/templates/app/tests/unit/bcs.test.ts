// Unit test — pure BCS, no devstack, no Docker. Runs under `pnpm test`.
//
// Exercises a BCS encode → decode round-trip against the GENERATED Move
// bindings. `Counter` is a `MoveStruct` (a `BcsType` from `@mysten/sui/bcs`),
// so `serialize(value).toBytes()` produces the on-wire bytes and `parse(bytes)`
// reads them back — the same codec the bindings use to decode on-chain object
// content (see `Counter.parse` in the generated utils). This proves the codegen
// emitted a usable codec and is the template consumer's starting point for
// writing their own BCS unit tests.

import { describe, expect, it } from 'vitest';

import { Counter } from '@generated/bindings/counter/counter.js';

describe('Counter BCS codec', () => {
	it('round-trips a value through encode → decode', () => {
		// `id`/`owner` are `bcs.Address` and `value` is `bcs.u64()`; u64 decodes
		// to a decimal string (BCS can't fit u64 in a JS number safely).
		const counter = {
			id: '0x0000000000000000000000000000000000000000000000000000000000000001',
			owner: '0x0000000000000000000000000000000000000000000000000000000000000002',
			value: '42',
		};

		const bytes = Counter.serialize(counter).toBytes();
		expect(bytes).toBeInstanceOf(Uint8Array);

		const decoded = Counter.parse(bytes);

		expect(decoded).toEqual(counter);
	});

	it('preserves a u64 value beyond Number.MAX_SAFE_INTEGER', () => {
		const counter = {
			id: '0x0000000000000000000000000000000000000000000000000000000000000003',
			owner: '0x0000000000000000000000000000000000000000000000000000000000000004',
			value: '18446744073709551615', // u64 max
		};

		expect(Counter.parse(Counter.serialize(counter).toBytes())).toEqual(counter);
	});
});
