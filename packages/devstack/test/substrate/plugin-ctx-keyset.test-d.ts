// INV-5 — PluginCtx is a CLOSED 5-key surface.
//
// This type-test pins `keyof PluginCtx` to exactly the 5 minimal verbs
// so a future PR cannot re-grow the god-object by sneaking a 6th
// service onto the ctx. It is validated by `tsc --noEmit` (the package
// tsconfig includes `test/**/*`).

import type { PluginCtx } from '../../src/substrate/plugin-ctx.ts';

// The canonical closed set. Order-insensitive (compared via mutual
// extends below).
type ExpectedKeys = 'codegen' | 'endpoint' | 'snapshotExtra' | 'publish' | 'provides';

type ActualKeys = keyof PluginCtx;

// Bidirectional key-set equality. If a key is added to or removed from
// `PluginCtx`, one of these two assignments fails to resolve to `true`.
type Assert<T extends true> = T;
type KeysEqual = [ActualKeys] extends [ExpectedKeys]
	? [ExpectedKeys] extends [ActualKeys]
		? true
		: false
	: false;

export type _KeysetPinned = Assert<KeysEqual>;

// Positive: every expected key is present and well-typed.
export const _present: Record<ExpectedKeys, true> = {
	codegen: true,
	endpoint: true,
	snapshotExtra: true,
	publish: true,
	provides: true,
};

// Negative: a 6th key must NOT be assignable to `keyof PluginCtx`.
// @ts-expect-error — 'tx' is not one of the 5 closed PluginCtx keys (INV-5)
export const _sixthKeyRejected: keyof PluginCtx = 'tx';

// Exact count guard: pin the canonical key list to a tuple of length 5.
// If the closed set ever changes, the `KeysEqual` assertion above fails;
// this tuple keeps the literal "5" visible at the test site.
type ExpectedTuple = ['codegen', 'endpoint', 'snapshotExtra', 'publish', 'provides'];
export type _ExactlyFive = Assert<ExpectedTuple['length'] extends 5 ? true : false>;
// Tie the tuple to the expected union so the two cannot drift apart.
export type _TupleMatchesUnion = Assert<
	ExpectedTuple[number] extends ExpectedKeys
		? ExpectedKeys extends ExpectedTuple[number]
			? true
			: false
		: false
>;
