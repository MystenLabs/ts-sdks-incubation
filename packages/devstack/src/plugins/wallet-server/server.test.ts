import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountsContext } from '../../core/types.js';
import { type WalletServerHandle, startWalletServer } from './server.js';

// HTTP boundary tests for the wallet-server plugin. The auth + body
// validation paths are the priority — they're the things a browser-side
// signer adapter (or a hostile network neighbor) sees first, and the
// architecture review flagged the auth flow + multi-format body parsing
// as silent-failure prone.

const TEST_TOKEN = 'a'.repeat(64);

const buildFakeAccounts = (signer: Ed25519Keypair): AccountsContext => {
	const map = new Map<string, Ed25519Keypair>([['alice', signer]]);
	return {
		names: () => [...map.keys()],
		has: (n) => map.has(n),
		get: (n) => {
			const s = map.get(n);
			if (s === undefined) throw new Error(`unknown account: ${n}`);
			return s;
		},
	};
};

let handle: WalletServerHandle | undefined;
let baseUrl: string;
let signer: Ed25519Keypair;
let aliceAddress: string;

beforeEach(async () => {
	signer = new Ed25519Keypair();
	aliceAddress = signer.toSuiAddress();
	handle = await startWalletServer({
		port: 0,
		accounts: buildFakeAccounts(signer),
		token: TEST_TOKEN,
		maxBodyBytes: 256,
		// Tests need the dev-server origin allow-listed so the CORS
		// path returns headers; we use the default localhost-only bind.
		allowedOrigins: ['http://localhost:5173'],
	});
	const addr = handle.server.address();
	if (addr === null || typeof addr === 'string') {
		throw new Error('expected an AddressInfo from the test server');
	}
	const port = (addr as AddressInfo).port;
	baseUrl = `http://localhost:${port}`;
});

afterEach(async () => {
	if (handle === undefined) return;
	await new Promise<void>((resolve) => handle?.server.close(() => resolve()));
	handle = undefined;
});

const authHeaders = (): HeadersInit => ({
	Authorization: `Bearer ${TEST_TOKEN}`,
	'Content-Type': 'application/json',
});

describe('GET /health (no auth required)', () => {
	it('returns 200 + {ok:true} without an Authorization header', async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns 200 even when garbage Authorization header is sent', async () => {
		const res = await fetch(`${baseUrl}/health`, {
			headers: { Authorization: 'Bearer not-the-real-token' },
		});
		expect(res.status).toBe(200);
	});
});

describe('Authentication on /api/v1/devstack endpoints', () => {
	it('GET /accounts without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Authentication required/);
	});

	it('GET /accounts with the wrong-length token returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: { Authorization: 'Bearer too-short' },
		});
		expect(res.status).toBe(401);
	});

	it('GET /accounts with a same-length but wrong token returns 401', async () => {
		const wrong = 'b'.repeat(64);
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: { Authorization: `Bearer ${wrong}` },
		});
		expect(res.status).toBe(401);
	});

	it('GET /accounts with the correct Bearer token returns the account list', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: authHeaders(),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accounts: Array<{ name: string; address: string; scheme: string; publicKey: string }>;
		};
		expect(body.accounts).toHaveLength(1);
		expect(body.accounts[0]).toMatchObject({
			name: 'alice',
			address: aliceAddress,
			scheme: 'ED25519',
		});
		expect(body.accounts[0]?.publicKey).toBe(signer.getPublicKey().toBase64());
	});

	it('Bearer header is case-insensitive on the scheme name', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: { Authorization: `bearer ${TEST_TOKEN}` },
		});
		expect(res.status).toBe(200);
	});

	it('?token=<token> query param is accepted as a fallback to the header', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts?token=${TEST_TOKEN}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { accounts: unknown[] };
		expect(body.accounts).toHaveLength(1);
	});

	it('?token=<wrong> falls back to 401', async () => {
		const wrong = 'b'.repeat(64);
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts?token=${wrong}`);
		expect(res.status).toBe(401);
	});
});

describe('Method/route mismatch', () => {
	it('POST /api/v1/devstack/accounts (with valid auth) returns 404', async () => {
		// The implementation only handles GET on /accounts; any other method
		// falls through to the catch-all 404 with a useful message.
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			method: 'POST',
			headers: authHeaders(),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/No route for POST/);
	});

	it('GET on an unknown path returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/nope`, {
			headers: authHeaders(),
		});
		expect(res.status).toBe(404);
	});
});

describe('POST /sign-transaction — body validation', () => {
	const url = (): string => `${baseUrl}/api/v1/devstack/sign-transaction`;

	it('returns 400 when address is missing', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ txBytes: toBase64(new Uint8Array([1, 2, 3])) }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Invalid address/);
	});

	it('returns 400 when txBytes is missing', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: aliceAddress }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Invalid txBytes/);
	});

	it('returns 400 when txBytes is not valid base64', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			// `!` is outside the base64 alphabet — fromBase64 rejects this.
			body: JSON.stringify({ address: aliceAddress, txBytes: '!!!not-base64!!!' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not valid base64/);
	});

	it('returns 404 when the signer is not in the account directory', async () => {
		const ghost = `0x${'1'.repeat(64)}`;
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: ghost, txBytes: toBase64(new Uint8Array([1])) }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/No signer for address/);
	});

	it('returns 400 when body is not a JSON object', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: 'not-json',
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Invalid JSON body/);
	});
});

describe('POST /sign-personal-message — body validation', () => {
	const url = (): string => `${baseUrl}/api/v1/devstack/sign-personal-message`;

	it('returns 400 when address is missing', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ messageBytes: toBase64(new Uint8Array([1, 2, 3])) }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Invalid address/);
	});

	it('returns 400 when messageBytes is missing', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: aliceAddress }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Invalid messageBytes/);
	});

	it('returns 400 when messageBytes is not valid base64', async () => {
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: aliceAddress, messageBytes: '!!!nope!!!' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not valid base64/);
	});

	it('returns 404 when the address is unknown', async () => {
		const ghost = `0x${'2'.repeat(64)}`;
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: ghost, messageBytes: toBase64(new Uint8Array([1])) }),
		});
		expect(res.status).toBe(404);
	});

	it('signs and returns a signature on the happy path', async () => {
		const message = new TextEncoder().encode('hello');
		const res = await fetch(url(), {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: aliceAddress, messageBytes: toBase64(message) }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { signature: string; bytes: string };
		expect(body.signature).toEqual(expect.any(String));
		expect(body.signature.length).toBeGreaterThan(0);
		expect(body.bytes).toBe(toBase64(message));
	});
});

describe('Body size enforcement', () => {
	it('returns 413 when the request body exceeds maxBodyBytes', async () => {
		// maxBodyBytes was set to 256 in beforeEach; send well over that.
		const huge = JSON.stringify({
			address: aliceAddress,
			txBytes: 'A'.repeat(2048),
		});
		expect(huge.length).toBeGreaterThan(256);
		const res = await fetch(`${baseUrl}/api/v1/devstack/sign-transaction`, {
			method: 'POST',
			headers: authHeaders(),
			body: huge,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/too large/);
	});
});

describe('CORS', () => {
	it('OPTIONS preflight from an allowlisted origin returns 204 + echoes the origin', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			method: 'OPTIONS',
			headers: { Origin: 'http://localhost:5173' },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
		expect(res.headers.get('vary')).toBe('Origin');
	});

	it('OPTIONS preflight without an Origin header still succeeds (same-origin / curl)', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('OPTIONS preflight from a non-allowlisted origin returns 403', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			method: 'OPTIONS',
			headers: { Origin: 'https://evil.example.com' },
		});
		expect(res.status).toBe(403);
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('GET from a non-allowlisted origin returns 403 even with valid auth', async () => {
		const res = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: { ...authHeaders(), Origin: 'https://evil.example.com' },
		});
		expect(res.status).toBe(403);
	});
});

describe('setAccounts hot-reload', () => {
	it('next /accounts request reflects the swapped AccountsContext', async () => {
		// Sanity: initial fixture has only alice.
		const before = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: authHeaders(),
		}).then((r) => r.json() as Promise<{ accounts: Array<{ name: string }> }>);
		expect(before.accounts.map((a) => a.name)).toEqual(['alice']);

		// Build a fresh AccountsContext with alice + a brand-new bob.
		const bob = new Ed25519Keypair();
		const map = new Map<string, Ed25519Keypair>([
			['alice', signer],
			['bob', bob],
		]);
		const refreshed: AccountsContext = {
			names: () => [...map.keys()],
			has: (n) => map.has(n),
			get: (n) => {
				const s = map.get(n);
				if (s === undefined) throw new Error(`unknown account: ${n}`);
				return s;
			},
		};
		handle?.setAccounts(refreshed);

		const after = await fetch(`${baseUrl}/api/v1/devstack/accounts`, {
			headers: authHeaders(),
		}).then((r) => r.json() as Promise<{ accounts: Array<{ name: string; address: string }> }>);
		expect(after.accounts.map((a) => a.name).sort()).toEqual(['alice', 'bob']);
		const bobEntry = after.accounts.find((a) => a.name === 'bob');
		expect(bobEntry?.address).toBe(bob.toSuiAddress());
	});

	it('sign-transaction picks up a hot-reloaded signer for a new address', async () => {
		const carol = new Ed25519Keypair();
		const map = new Map<string, Ed25519Keypair>([
			['alice', signer],
			['carol', carol],
		]);
		const refreshed: AccountsContext = {
			names: () => [...map.keys()],
			has: (n) => map.has(n),
			get: (n) => {
				const s = map.get(n);
				if (s === undefined) throw new Error(`unknown account: ${n}`);
				return s;
			},
		};
		handle?.setAccounts(refreshed);

		const fakeTxBytes = toBase64(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
		const res = await fetch(`${baseUrl}/api/v1/devstack/sign-transaction`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ address: carol.toSuiAddress(), transactionBlock: fakeTxBytes }),
		});
		// The fake tx bytes will fail signing (400), but the point of this
		// test is that the *address* resolves to a known signer post-hot-reload.
		// A 404 would mean the address wasn't found in the swapped accounts —
		// the bug F7 fixed. Any other status means we got past the address
		// lookup, so hot-reload worked.
		expect(res.status).not.toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error ?? '').not.toMatch(/no signer for/i);
	});
});

describe('CORS — allowedOrigins validation', () => {
	it('rejects "*" in allowedOrigins at startup', async () => {
		const sig = new Ed25519Keypair();
		await expect(
			startWalletServer({
				port: 0,
				accounts: buildFakeAccounts(sig),
				token: TEST_TOKEN,
				allowedOrigins: ['*'],
			}),
		).rejects.toThrow(/cannot include "\*"/);
	});

	it('rejects malformed origins', async () => {
		const sig = new Ed25519Keypair();
		await expect(
			startWalletServer({
				port: 0,
				accounts: buildFakeAccounts(sig),
				token: TEST_TOKEN,
				allowedOrigins: ['not a url'],
			}),
		).rejects.toThrow(/invalid origin/);
	});
});
