// Regression test for the wallet body-cap enforcement model.
//
// Bug fix (review fix phase 22e/Bug 1): `decodeJsonBody` previously
// re-checked `body.length > MAX_BODY_BYTES` AFTER the listener
// concatenated and decoded the request body. `body` at that point is
// a JS string, so `.length` counts UTF-16 code units, not bytes — a
// 64 KiB byte payload of multi-byte (e.g. 4-byte BMP) runes would
// pass the secondary check despite being >64 KiB on the wire. The
// listener at `req.on('data', …)` already enforces the byte cap
// correctly (it accumulates `chunk.length` byte counts from
// `Buffer` chunks and writes a 413 the moment the running total
// crosses `MAX_BODY_BYTES`), so the in-dispatcher check was
// redundant defense at best and a UTF-16-vs-bytes-confused gap at
// worst.
//
// This test pins the new contract: the LISTENER is the sole
// enforcement point. The dispatcher accepts any string body (the
// listener has already gated by byte count), and so a 64 KiB-string
// body delivered directly to `dispatch` flows past the legacy
// "cap-check" point and lands at the schema decoder — where it
// fails with a body-invalid because it isn't JSON, not because of
// the byte cap. That distinction is the regression sentinel: the
// failure code we observe is `body-invalid` (schema), NOT a body
// cap rejection.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type { AccountValue } from '../../../src/plugins/account/service.ts';
import {
	dispatch,
	MAX_BODY_BYTES,
	type WalletServerConfig,
} from '../../../src/plugins/wallet/server.ts';
import { WALLET_AUTH_HEADER, WalletHttpPath } from '../../../src/plugins/wallet/protocol.ts';
import type { OriginPolicy } from '../../../src/plugins/wallet/origin-policy.ts';
import type { PairingToken } from '../../../src/plugins/wallet/pairing.ts';

const ALLOWED_ORIGIN = 'http://dev.test.localhost:5173';
const TOKEN = 'cafebabe'.repeat(4) as PairingToken; // 32 hex chars

const policy: OriginPolicy = {
	allowed: new Set([ALLOWED_ORIGIN]),
};

const accounts: ReadonlyMap<string, AccountValue> = new Map();

const config: WalletServerConfig = {
	bindAddress: '127.0.0.1',
	port: 65000,
	token: TOKEN,
	policy,
	accountsByAddress: accounts,
};

describe('wallet dispatcher — listener is the sole body-cap enforcement point', () => {
	it.effect('accepts an oversized body at the dispatcher level (listener already gated)', () =>
		Effect.gen(function* () {
			// Construct a body MUCH larger than MAX_BODY_BYTES. In the
			// real listener path this would never reach the dispatcher —
			// the listener would 413 + destroy the socket the moment the
			// `chunk.length` running total crosses the cap. But the
			// dispatcher is tested directly here to confirm it no
			// longer carries a duplicate (and UTF-16-buggy) cap check.
			const oversized = 'x'.repeat(MAX_BODY_BYTES * 2);
			const response = yield* dispatch(config, {
				method: 'POST',
				url: WalletHttpPath.SIGN_TRANSACTION,
				headers: {
					origin: ALLOWED_ORIGIN,
					[WALLET_AUTH_HEADER]: `Bearer ${TOKEN}`,
				},
				body: oversized,
			});

			// The response should be a schema-decode failure (the body
			// is non-JSON), NOT a body-cap rejection. The body-cap path
			// would have surfaced a `'body-invalid'` code with the
			// `body exceeds ...-byte cap` message — neither should
			// appear here.
			expect(response.status).toBe(400);
			const parsed = JSON.parse(response.body) as { readonly error: string; readonly code: string };
			expect(parsed.code).toBe('body-invalid');
			expect(parsed.error).toBe('invalid JSON body');
			expect(parsed.error).not.toMatch(/byte cap/i);
		}),
	);

	it.effect(
		'accepts a multi-byte body that is UNDER the cap in UTF-16 units but OVER it in UTF-8 bytes',
		() =>
			Effect.gen(function* () {
				// This is the DISCRIMINATING case for the bug. Astral-plane
				// runes are 2 UTF-16 code units in a JS string but 4 UTF-8
				// bytes on the wire. We size the body so it straddles the cap
				// on exactly the axis the old code got wrong:
				//
				//   UTF-16 length = 2 * n   (what `String.length`/`body.length`
				//                            counts — the OLD check's axis)
				//   UTF-8 bytes   = 4 * n   (the real wire size — the cap's
				//                            intended axis)
				//
				// Choose n so `2n < MAX_BODY_BYTES < 4n` — i.e. the body looks
				// SMALL to a UTF-16 `.length` check but is genuinely OVER the
				// byte cap. With MAX_BODY_BYTES = 64 KiB, any n in
				// (16384, 32768) works; n = 20000 gives 40000 UTF-16 units
				// (< 65536) and 80000 UTF-8 bytes (> 65536).
				const astralRune = '\u{1F600}'; // 4 UTF-8 bytes, 2 UTF-16 code units
				const runeCount = 20_000;
				const body = astralRune.repeat(runeCount);

				// Pin the straddle precondition so the test's discriminating
				// power can't silently erode if MAX_BODY_BYTES is retuned.
				expect(body.length).toBeLessThan(MAX_BODY_BYTES); // UTF-16 units under cap
				expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES); // bytes over cap

				const response = yield* dispatch(config, {
					method: 'POST',
					url: WalletHttpPath.SIGN_TRANSACTION,
					headers: {
						origin: ALLOWED_ORIGIN,
						[WALLET_AUTH_HEADER]: `Bearer ${TOKEN}`,
					},
					body,
				});

				// The OLD dispatcher's `body.length > MAX_BODY_BYTES` check
				// would have ACCEPTED this body (40000 UTF-16 units < cap) and
				// then schema-decoded it. The buggy outcome and the correct
				// outcome are indistinguishable on THIS body — which is the
				// point: the regression sentinel is that a CORRECT byte-cap
				// check reintroduced at the dispatcher (the over-correction)
				// would reject this 80 KiB-on-the-wire body with a
				// `byte cap` message. The current contract — listener is the
				// sole gate, dispatcher has NO cap check — surfaces the
				// non-JSON body as a schema `body-invalid` instead.
				expect(response.status).toBe(400);
				const parsed = JSON.parse(response.body) as {
					readonly error: string;
					readonly code: string;
				};
				expect(parsed.code).toBe('body-invalid');
				expect(parsed.error).toBe('invalid JSON body');
				expect(parsed.error).not.toMatch(/byte cap/i);
			}),
	);
});
