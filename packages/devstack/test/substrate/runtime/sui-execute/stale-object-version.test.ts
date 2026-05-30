// `isSuiStaleObjectVersionError` — SDK-message classifier pinning tests.
//
// This predicate sniffs the SDK's "stale object version" transient
// failure by substring — the underlying gRPC error class exposes no
// structured discriminator. A wording change in the SDK (or a typo in
// the matched substrings) would silently disable the
// `STALE_OBJECT_VERSION_RETRY_PROFILE` retry, so we pin BOTH the
// matched canonical wording and a spread of unmatched messages.
//
// `isSuiStaleObjectVersionError` is EXPORTED, so we test it directly.

import { describe, expect, it } from '@effect/vitest';

import {
	isSuiStaleObjectVersionError,
	SuiExecuteError,
} from '../../../../src/substrate/runtime/sui-execute/index.ts';

const errorWith = (message: string): SuiExecuteError =>
	new SuiExecuteError({
		phase: 'execute',
		signerName: 'alice',
		signerAddress: '0xa11ce',
		message,
	});

describe('isSuiStaleObjectVersionError', () => {
	it('matches the SDK canonical "needs to be rebuilt because object … current version" wording', () => {
		expect(
			isSuiStaleObjectVersionError(
				errorWith(
					'Transaction needs to be rebuilt because object 0xabc is not available at the current version 42',
				),
			),
		).toBe(true);
	});

	it('matches when the SDK message arrives URI-encoded', () => {
		// The Sui SDK emits `decodeURIComponent`-able strings for some
		// error paths; the classifier decodes before matching. A
		// space-encoded variant must still match.
		const encoded = encodeURIComponent(
			'needs to be rebuilt because object 0xfeed is stale; current version is 7',
		);
		expect(isSuiStaleObjectVersionError(errorWith(encoded))).toBe(true);
	});

	it('requires BOTH substrings — "needs to be rebuilt because object" alone does NOT match', () => {
		// Only one of the two anchors present: must not match (would
		// otherwise over-trigger retries on unrelated rebuild errors).
		expect(
			isSuiStaleObjectVersionError(
				errorWith('needs to be rebuilt because object 0xabc has the wrong type'),
			),
		).toBe(false);
	});

	it('requires BOTH substrings — "current version" alone does NOT match', () => {
		expect(
			isSuiStaleObjectVersionError(
				errorWith('object at current version is owned by a different address'),
			),
		).toBe(false);
	});

	it('does NOT match unrelated execution failures', () => {
		for (const message of [
			'MoveAbort(MoveLocation { ... }, 1) in command 0',
			'Insufficient gas: balance 0 < required 1000',
			'InvalidSignature: signature verification failed',
			'Object 0xabc does not exist',
			'',
		]) {
			expect(isSuiStaleObjectVersionError(errorWith(message))).toBe(false);
		}
	});

	it('falls back to the raw message when decode fails (and still matches on the raw)', () => {
		// A lone `%` is not a valid `decodeURIComponent` input; the
		// classifier swallows the throw and matches against the raw
		// string. Both anchors are present in the raw form, so it matches.
		expect(
			isSuiStaleObjectVersionError(
				errorWith('100% needs to be rebuilt because object 0xa is at current version 3'),
			),
		).toBe(true);
	});
});
