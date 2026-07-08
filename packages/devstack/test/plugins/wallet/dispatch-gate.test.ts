// Wallet dispatcher gate-ordering regression test.
//
// Bug fix: the path-prefix gate must run BEFORE the OPTIONS preflight
// (server.ts:dispatch steps 1 then 2). Otherwise an allowed origin could
// send `OPTIONS /anything` and pull back a `204 + CORS` response,
// effectively probing CORS for arbitrary (non-protocol) paths. With the
// prefix gate first, an OPTIONS to a non-protocol path is a flat 404
// (text/plain, no CORS), while an OPTIONS to the protocol prefix from an
// allowed origin still earns the `204 + CORS` preflight.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { dispatch, type WalletServerConfig } from '../../../src/plugins/wallet/server.ts';
import { WalletHttpPath } from '../../../src/plugins/wallet/protocol.ts';
import type { OriginPolicy } from '../../../src/plugins/wallet/origin-policy.ts';
import type { PairingToken } from '../../../src/plugins/wallet/pairing.ts';

const ALLOWED_ORIGIN = 'http://dev.test.localhost:5173';
const TOKEN = 'cafebabe'.repeat(4) as PairingToken; // 32 hex chars

const policy: OriginPolicy = {
	allowed: new Set([ALLOWED_ORIGIN]),
	routedAppOriginPattern: null,
	routedAppOriginScope: null,
};

const accounts: ReadonlyMap<string, AccountValue> = new Map();

const config: WalletServerConfig = {
	bindAddress: '127.0.0.1',
	port: 65000,
	token: TOKEN,
	policy,
	accountsByAddress: accounts,
};

describe('wallet dispatcher — path-prefix gate runs before the OPTIONS preflight', () => {
	it.effect('OPTIONS to a NON-protocol path is a flat 404 (not 204 + CORS)', () =>
		Effect.gen(function* () {
			const response = yield* dispatch(config, {
				method: 'OPTIONS',
				url: '/not/the/protocol/path',
				headers: { origin: ALLOWED_ORIGIN },
				body: '',
			});

			// Prefix gate fires first: a path outside `/api/v1/devstack/*`
			// never reaches the OPTIONS preflight, so no CORS leaks.
			expect(response.status).toBe(404);
			expect(response.body).toBe('not found');
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
		}),
	);

	it.effect('OPTIONS to the protocol prefix from an allowed origin is 204 + CORS', () =>
		Effect.gen(function* () {
			const response = yield* dispatch(config, {
				method: 'OPTIONS',
				url: WalletHttpPath.HEALTH,
				headers: { origin: ALLOWED_ORIGIN },
				body: '',
			});

			expect(response.status).toBe(204);
			expect(response.body).toBe('');
			expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
			expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
		}),
	);

	it.effect('OPTIONS to the protocol prefix from a NON-allowed origin is 403 (no CORS)', () =>
		Effect.gen(function* () {
			const response = yield* dispatch(config, {
				method: 'OPTIONS',
				url: WalletHttpPath.HEALTH,
				headers: { origin: 'http://evil.localhost:5173' },
				body: '',
			});

			// Inside the protocol prefix, but the origin is not allowlisted:
			// the preflight refuses without echoing CORS headers.
			expect(response.status).toBe(403);
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
		}),
	);
});
