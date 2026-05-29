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
	supervisorCtx: null,
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

	it.effect('accepts a UTF-8-multi-byte body whose JS-string length is under the cap', () =>
		Effect.gen(function* () {
			// Emoji and astral plane runes are 2 UTF-16 code units each
			// in a JS string, but 4 bytes each on the wire. A body that
			// is ~32 KiB of JS-string length corresponds to ~64 KiB of
			// UTF-8 bytes. The OLD `body.length` check would have
			// happily accepted this oversized-on-the-wire payload. The
			// new contract is that the dispatcher doesn't gate at all
			// — the LISTENER's byte counter is authoritative — so any
			// reachable dispatcher call by definition has been pre-
			// gated, regardless of UTF-8 vs UTF-16 unit count.
			const astralRune = '\u{1F600}'; // 4 UTF-8 bytes, 2 UTF-16 code units
			const body = astralRune.repeat(1024); // ~2 KiB string length, ~4 KiB bytes
			const response = yield* dispatch(config, {
				method: 'POST',
				url: WalletHttpPath.SIGN_TRANSACTION,
				headers: {
					origin: ALLOWED_ORIGIN,
					[WALLET_AUTH_HEADER]: `Bearer ${TOKEN}`,
				},
				body,
			});

			// Again: schema-decode failure (non-JSON), not body-cap.
			expect(response.status).toBe(400);
			const parsed = JSON.parse(response.body) as { readonly error: string; readonly code: string };
			expect(parsed.code).toBe('body-invalid');
			expect(parsed.error).not.toMatch(/byte cap/i);
		}),
	);
});
