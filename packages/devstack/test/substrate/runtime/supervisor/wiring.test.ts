// Supervisor wiring helpers — regression + invariant tests.
//
// Pin the canonicalization of `StrategyNotFoundError` (STYLE_GUIDE §2:
// one `_tag` literal per logical error type across the whole package):
//
//   1. `noopStrategyRegistry.get(key)` MUST fail with an instance of
//      the canonical `StrategyNotFoundError` class from
//      `substrate/runtime/errors.ts` — NOT a structural literal.
//   2. Package-wide grep invariant — no inline
//      `_tag: 'StrategyNotFoundError'` literal occurrences anywhere
//      in `src/`. Failing this test means a duplicate definition has
//      re-introduced the structural shape the C4 cleanup removed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { StrategyNotFoundError } from '../../../../src/substrate/runtime/errors.ts';
import { noopStrategyRegistry } from '../../../../src/substrate/runtime/supervisor/wiring.ts';

describe('noopStrategyRegistry.get', () => {
	it.effect('fails with the canonical StrategyNotFoundError class', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(noopStrategyRegistry.get('coinType:WAL'));
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(err._tag).toBe('Some');
			if (err._tag === 'Some') {
				// instanceof — same class identity, no structural lookalike.
				expect(err.value).toBeInstanceOf(StrategyNotFoundError);
				// _tag — matches the canonical literal.
				expect(err.value._tag).toBe('StrategyNotFoundError');
				expect(err.value.capabilityKey).toBe('coinType:WAL');
				expect(err.value.registeredKeys).toEqual([]);
			}
		}),
	);
});

// -----------------------------------------------------------------------------
// Package-wide invariant: no structural `_tag: 'StrategyNotFoundError'` literal
// -----------------------------------------------------------------------------
//
// The only `'StrategyNotFoundError'` string in `src/` outside of identifier
// references is the tag literal inside the class definition at
// `substrate/runtime/errors.ts`. Every other occurrence is either:
//   - the `Effect.catchTag('StrategyNotFoundError', ...)` call sites in
//     `plugins/account/funding.ts` (idiomatic — tag-based subscription),
//   - or identifier references to the imported class.
//
// What MUST NOT appear: `_tag: 'StrategyNotFoundError'` or
// `_tag: "StrategyNotFoundError"` — that pattern indicates a structural
// literal that bypasses the class constructor (the bug C4 removed).

const SRC_ROOT = resolve(__dirname, '../../../../src');

const walk = (dir: string): ReadonlyArray<string> => {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) {
			out.push(...walk(full));
		} else if (full.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
};

const STRUCTURAL_LITERAL_PATTERN = /_tag\s*:\s*['"]StrategyNotFoundError['"]/;

describe('StrategyNotFoundError invariant', () => {
	it('has no structural `_tag` literal anywhere in src/', () => {
		const offenders: Array<{ readonly file: string; readonly line: number }> = [];
		for (const file of walk(SRC_ROOT)) {
			const lines = readFileSync(file, 'utf8').split('\n');
			lines.forEach((line, i) => {
				if (STRUCTURAL_LITERAL_PATTERN.test(line)) {
					offenders.push({ file, line: i + 1 });
				}
			});
		}
		expect(offenders).toEqual([]);
	});
});
