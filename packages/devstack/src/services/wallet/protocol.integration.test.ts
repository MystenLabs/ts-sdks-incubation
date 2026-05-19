// Wallet protocol integration test — exercises the full HTTP contract
// between `walletApp()` (the devstack-side signing server) and
// `DevstackSignerAdapter` (the dev-wallet–side client) in a single
// process.
//
// Scope (post-launch sweep §3.4 / W12-coordinated):
//   1. Wallet HTTP server stands up under `Effect.scoped`, bound to the
//      router-fronted host on the well-known wallet entrypoint port.
//   2. A real `Ed25519Keypair`-backed Account is exposed so signatures
//      coming back over the wire are cryptographically real (the test
//      verifies them with `verifyTransactionSignature` /
//      `verifyPersonalMessageSignature`).
//   3. The dev-wallet `DevstackSignerAdapter` initializes against the
//      server, hydrates its account list, and round-trips both
//      sign-transaction and sign-personal-message through the real
//      `DevstackProxySigner` HTTP path.
//   4. The protocol's CSRF/auth surface (mandatory Origin, bearer
//      bypass-rejection) is also pinned — drift on either side surfaces
//      here rather than at first dev-wallet user pair-up.
//
// Why this lives alongside `protocol.test.ts` (the byte-equality guard)
// rather than replacing it: this test catches *behavioral* drift (router
// dispatch, body shape, status codes); the sibling test catches *literal*
// drift in the path-table mirror. Both fail-fast.

import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature, verifyTransactionSignature } from '@mysten/sui/verify';
import { Transaction } from '@mysten/sui/transactions';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';
import { Identity } from '../../engine/identity.js';
import { PortAllocatorLive } from '../../engine/port-allocator.js';
import { EndpointRegistryLive } from '../../engine/registries.js';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import type { Account } from '../../engine/shared.js';
import { SuiTag, type Sui } from '../sui.js';
import { walletApp, type WalletApp } from './internal.js';
import { WalletHttpPath } from './protocol.js';

// -----------------------------------------------------------------------------
// Stack-of-stubs setup — minimal SuiTag + a real-keypair-backed Account.
// The wallet-app body only YIELDS Sui for ordering (it never reads the
// chain), so a stub with no-op handlers is fine. The Account, in
// contrast, IS exercised end-to-end: its sign closures must return real
// `{ bytes, signature }` shapes the dev-wallet adapter can hand back to
// `verifyTransactionSignature` without further massaging.
// -----------------------------------------------------------------------------

const stubSui: Layer.Layer<SuiTag> = Layer.succeed(SuiTag, {
	network: 'localnet',
	rpc: { host: 'http://localhost:9000' },
	chainId: 'test-chain',
	client: {} as unknown as Sui['client'],
	waitForTransactionsReady: () => Effect.void,
	runtime: 'bundled',
});

// Identity drives the router hostname + the dev-server allowedOrigins.
// `app: 'wallet-test'` gives a stable `wallet.wallet-test.localhost` host
// the test asserts against.
const identityLayer = Layer.succeed(Identity, {
	app: 'wallet-test',
	stack: 'main',
	network: 'localnet',
});

interface KeyedAccount {
	readonly tag: LayeredTag<string, Account, never, never>;
	readonly keypair: Ed25519Keypair;
	readonly account: Account;
}

/** Build a real-keypair Account tag — sign closures defer to a live
 *  `Ed25519Keypair` so the produced signatures verify under
 *  `@mysten/sui/verify`. No StateStore, faucet, or RPC dependencies; the
 *  test focuses on the HTTP wire contract, not on funding/leasing. */
const realKeyAccountTag = (name: string): KeyedAccount => {
	const keypair = Ed25519Keypair.generate();
	const publicKey = keypair.getPublicKey();
	const account: Account = {
		name,
		address: publicKey.toSuiAddress(),
		publicKey: publicKey.toRawBytes(),
		scheme: 'ed25519',
		source: 'real',
		signAndExecute: () => Effect.die('signAndExecute should not be reached in this test'),
		signTransaction: (transactionBytes) =>
			Effect.tryPromise({
				try: () => keypair.signTransaction(transactionBytes),
				catch: (cause) => ({
					_tag: 'SignAndExecuteError' as const,
					message: `keypair.signTransaction failed: ${String(cause)}`,
					cause,
				}),
			}),
		signPersonalMessage: (messageBytes) =>
			Effect.tryPromise({
				try: () => keypair.signPersonalMessage(messageBytes),
				catch: (cause) => ({
					_tag: 'SignAndExecuteError' as const,
					message: `keypair.signPersonalMessage failed: ${String(cause)}`,
					cause,
				}),
			}),
	};
	const acctTag = tag(name, Effect.succeed(account));
	return { tag: acctTag, keypair, account };
};

// -----------------------------------------------------------------------------
// Router file-provider isolation. The wallet-app writes YAML under
// `DEVSTACK_ROUTER_DYNAMIC_DIR` at boot; point it at a tmpdir for each
// test so we don't touch the user's real dynamic directory and so the
// finalizer's removal call has somewhere to point.
// -----------------------------------------------------------------------------

let savedRouterDir: string | undefined;
let tmpRouterDir: string | undefined;

beforeEach(() => {
	savedRouterDir = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
	tmpRouterDir = mkdtempSync(join(tmpdir(), 'devstack-wallet-protocol-'));
	process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = tmpRouterDir;
});

afterEach(() => {
	if (tmpRouterDir !== undefined) {
		rmSync(tmpRouterDir, { recursive: true, force: true });
		tmpRouterDir = undefined;
	}
	if (savedRouterDir === undefined) {
		delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
	} else {
		process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedRouterDir;
	}
});

// -----------------------------------------------------------------------------
// Free-port helper — bind a transient `net.Server` on 127.0.0.1 with
// port 0, ask the OS what it gave us, release it, hand the number back.
// Two parallel test files would otherwise both ask for the default 5180
// and clobber each other.
// -----------------------------------------------------------------------------

const acquireEphemeralPort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const addr = probe.address();
			if (addr === null || typeof addr === 'string') {
				probe.close();
				reject(new Error('failed to resolve ephemeral port'));
				return;
			}
			const port = addr.port;
			probe.close(() => resolve(port));
		});
	});

/** Compose the layer cake — base services + wallet-app + the account
 *  tag's transitively-flattened layers. Mirrors how
 *  `composeStackLayer` folds the user stack in production. */
const buildStack = (app: ReturnType<typeof walletApp>, acct: KeyedAccount) => {
	const baseLayer = Layer.mergeAll(stubSui, identityLayer, PortAllocatorLive, EndpointRegistryLive);
	const userLayer = Layer.provideMerge(app.__layer, acct.tag.__layer);
	return Layer.provide(userLayer, baseLayer);
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('walletApp ↔ DevstackSignerAdapter HTTP protocol', () => {
	it.effect(
		'health probe round-trip — token parses, bearer + Origin accepted, body shape matches',
		() =>
			Effect.gen(function* () {
				const port = yield* Effect.promise(acquireEphemeralPort);
				const acct = realKeyAccountTag('alice');
				const app = walletApp({ accounts: [acct.tag], port });
				const stack = buildStack(app, acct);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const value = (yield* app) as WalletApp;
						// The pairUrl carries the token in the fragment form
						// (post-C13). The same parser the dev-wallet
						// `createDevstackAdapterFromManifest` uses lifts it
						// back out for the adapter constructor.
						const token = parseDevstackToken(value.pairUrl);
						expect(token).not.toBeNull();
						expect(token).toMatch(/^[0-9a-f]{32}$/);

						const origin = `http://127.0.0.1:${value.localPort}`;
						// `http://localhost:5175` is in the auto-derived
						// dev-server allow-list, so it round-trips a 200.
						const healthRes = yield* Effect.promise(() =>
							fetch(`${origin}${WalletHttpPath.HEALTH}`, {
								headers: {
									Origin: 'http://localhost:5175',
									Authorization: `Bearer ${token!}`,
								},
							}),
						);
						expect(healthRes.status).toBe(200);
						const body = (yield* Effect.promise(() => healthRes.json())) as {
							ok?: boolean;
						};
						expect(body.ok).toBe(true);
					}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
				);
			}),
	);

	it.effect(
		'DevstackSignerAdapter hydrates accounts off the protocol (server-side adapter wire)',
		() =>
			// The dev-wallet `DevstackSignerAdapter` runs in the browser in
			// production; its `fetch` carries an Origin header automatically
			// and that Origin is in the server's allow-list (auto-derived
			// from `Identity` + extras passed via `WalletOptions.allowedOrigins`).
			// In Node, `fetch` doesn't auto-set Origin and the wallet server
			// fails-closed under `/api/v1/devstack/*` (C12). We mirror the
			// browser behavior here by wrapping the adapter call in a small
			// monkey-patched `globalThis.fetch` that injects an allowed
			// Origin — same effect as the browser, no real change to the
			// adapter's wire path.
			Effect.gen(function* () {
				const port = yield* Effect.promise(acquireEphemeralPort);
				const acct = realKeyAccountTag('alice');
				const app = walletApp({ accounts: [acct.tag], port });
				const stack = buildStack(app, acct);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const value = (yield* app) as WalletApp;
						const token = parseDevstackToken(value.pairUrl);
						const origin = `http://127.0.0.1:${value.localPort}`;

						// Browser-like fetch shim — injects the allowed Origin
						// on every wallet request. Restored in the finalizer.
						const realFetch = globalThis.fetch;
						const injectedOrigin = 'http://localhost:5175';
						globalThis.fetch = ((input, init) => {
							const url =
								typeof input === 'string'
									? input
									: input instanceof URL
										? input.toString()
										: input.url;
							if (url.startsWith(`${origin}/api/v1/devstack/`)) {
								const headers = new Headers(init?.headers);
								if (!headers.has('Origin')) headers.set('Origin', injectedOrigin);
								return realFetch(input, { ...init, headers });
							}
							return realFetch(input, init);
						}) as typeof fetch;
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								globalThis.fetch = realFetch;
							}),
						);

						const adapter = new DevstackSignerAdapter({
							serverOrigin: origin,
							token,
						});
						yield* Effect.promise(() => adapter.initialize());
						const accounts = adapter.getAccounts();
						expect(accounts.length).toBe(1);
						expect(accounts[0]!.address).toBe(acct.account.address);
						expect(accounts[0]!.signer.getPublicKey().toRawBytes()).toEqual(acct.account.publicKey);
						adapter.destroy();
					}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
				);
			}),
	);

	it.effect(
		'sign-transaction round-trip produces a signature that verifies under @mysten/sui/verify',
		() =>
			Effect.gen(function* () {
				const port = yield* Effect.promise(acquireEphemeralPort);
				const acct = realKeyAccountTag('bob');
				const app = walletApp({ accounts: [acct.tag], port });
				const stack = buildStack(app, acct);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const value = (yield* app) as WalletApp;
						const token = parseDevstackToken(value.pairUrl);
						expect(token).not.toBeNull();

						const origin = `http://127.0.0.1:${value.localPort}`;

						// Build a real BCS-serializable transaction. The
						// wallet server doesn't execute it — it just hands
						// the bytes to `account.signTransaction(bytes)`,
						// which routes to `keypair.signTransaction(bytes)`
						// under the hood. Don't `build()` (which would need
						// a SuiClient for object lookups); use
						// `kind: 'TransactionData'`-shape bytes that the
						// SDK keypair signs verbatim.
						const tx = new Transaction();
						tx.setSender(acct.account.address);
						tx.setGasBudget(1_000_000n);
						tx.setGasPrice(1000n);
						tx.setGasPayment([
							{
								objectId: '0x0000000000000000000000000000000000000000000000000000000000000001',
								version: '1',
								digest: '11111111111111111111111111111111',
							},
						]);
						const txBytes = yield* Effect.promise(() => tx.build({ onlyTransactionKind: false }));

						// Drive the protocol's POST sign-transaction
						// endpoint directly so we control the Origin
						// header (the dev-wallet `DevstackProxySigner`
						// runs in the browser; in Node `fetch` omits
						// Origin, which the server would reject). The
						// allowed-origins list auto-derives the
						// dev-server hostname; we hit it through the
						// same channel.
						const signRes = yield* Effect.promise(() =>
							fetch(`${origin}${WalletHttpPath.SIGN_TX}`, {
								method: 'POST',
								headers: {
									Origin: 'http://localhost:5175',
									Authorization: `Bearer ${token!}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									address: acct.account.address,
									txBytes: toBase64(txBytes),
								}),
							}),
						);
						expect(signRes.status).toBe(200);
						const body = (yield* Effect.promise(() => signRes.json())) as {
							suiSignature?: string;
							txBytes?: string;
						};
						expect(body.suiSignature).toBeDefined();
						expect(body.txBytes).toBeDefined();
						// Server echoes back the same bytes (base64) so
						// callers can forward to `executeTransactionBlock`
						// without re-serialization.
						expect(fromBase64(body.txBytes!)).toEqual(txBytes);

						// Verify the signature cryptographically — closes
						// the loop on the wire-encoded {bytes, signature}
						// shape being correct end-to-end.
						const verifiedPk = yield* Effect.promise(() =>
							verifyTransactionSignature(txBytes, body.suiSignature!),
						);
						expect(verifiedPk.toSuiAddress()).toBe(acct.account.address);
					}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
				);
			}),
	);

	it.effect(
		'sign-personal-message round-trip produces a signature that verifies under @mysten/sui/verify',
		() =>
			Effect.gen(function* () {
				const port = yield* Effect.promise(acquireEphemeralPort);
				const acct = realKeyAccountTag('carol');
				const app = walletApp({ accounts: [acct.tag], port });
				const stack = buildStack(app, acct);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const value = (yield* app) as WalletApp;
						const token = parseDevstackToken(value.pairUrl);
						const origin = `http://127.0.0.1:${value.localPort}`;

						const message = new TextEncoder().encode('hello devstack wallet');
						const signRes = yield* Effect.promise(() =>
							fetch(`${origin}${WalletHttpPath.SIGN_PERSONAL_MESSAGE}`, {
								method: 'POST',
								headers: {
									Origin: 'http://localhost:5175',
									Authorization: `Bearer ${token!}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									address: acct.account.address,
									messageBytes: toBase64(message),
								}),
							}),
						);
						expect(signRes.status).toBe(200);
						const body = (yield* Effect.promise(() => signRes.json())) as {
							signature?: string;
							bytes?: string;
						};
						expect(body.signature).toBeDefined();
						expect(body.bytes).toBeDefined();
						expect(fromBase64(body.bytes!)).toEqual(message);

						const verifiedPk = yield* Effect.promise(() =>
							verifyPersonalMessageSignature(message, body.signature!),
						);
						expect(verifiedPk.toSuiAddress()).toBe(acct.account.address);
					}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
				);
			}),
	);

	it.effect(
		'signing endpoints reject missing Origin (C12 — closes the curl/non-browser bypass)',
		() =>
			Effect.gen(function* () {
				const port = yield* Effect.promise(acquireEphemeralPort);
				const acct = realKeyAccountTag('dave');
				const app = walletApp({ accounts: [acct.tag], port });
				const stack = buildStack(app, acct);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const value = (yield* app) as WalletApp;
						const token = parseDevstackToken(value.pairUrl);
						const origin = `http://127.0.0.1:${value.localPort}`;
						// Send WITHOUT Origin. Node `fetch` honors that.
						// The signing path's mandatory-Origin check
						// (services/wallet/internal.ts C12) MUST 403.
						const res = yield* Effect.promise(() =>
							fetch(`${origin}${WalletHttpPath.SIGN_TX}`, {
								method: 'POST',
								headers: {
									Authorization: `Bearer ${token!}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									address: acct.account.address,
									txBytes: toBase64(new Uint8Array([1, 2, 3])),
								}),
							}),
						);
						expect(res.status).toBe(403);
					}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
				);
			}),
	);

	it.effect('signing endpoints reject a wrong bearer token (401)', () =>
		Effect.gen(function* () {
			const port = yield* Effect.promise(acquireEphemeralPort);
			const acct = realKeyAccountTag('eve');
			const app = walletApp({ accounts: [acct.tag], port });
			const stack = buildStack(app, acct);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const value = (yield* app) as WalletApp;
					const origin = `http://127.0.0.1:${value.localPort}`;
					const res = yield* Effect.promise(() =>
						fetch(`${origin}${WalletHttpPath.SIGN_TX}`, {
							method: 'POST',
							headers: {
								Origin: 'http://localhost:5175',
								// 32 hex chars (matches the on-disk shape
								// the wallet expects, so the
								// length-check passes and the
								// constant-time compare actually runs).
								Authorization: 'Bearer 00000000000000000000000000000000',
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								address: acct.account.address,
								txBytes: toBase64(new Uint8Array([1])),
							}),
						}),
					);
					expect(res.status).toBe(401);
				}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
			);
		}),
	);

	it.effect('accounts endpoint surfaces the resolved Account shape (name + address + scheme)', () =>
		Effect.gen(function* () {
			const port = yield* Effect.promise(acquireEphemeralPort);
			const acct = realKeyAccountTag('frank');
			const app = walletApp({ accounts: [acct.tag], port });
			const stack = buildStack(app, acct);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const value = (yield* app) as WalletApp;
					const token = parseDevstackToken(value.pairUrl);
					const origin = `http://127.0.0.1:${value.localPort}`;
					// Hit ACCOUNTS with a Origin so we exercise the
					// CORS-allowed branch as well as the no-Origin path.
					// Use an explicitly-allowed origin
					// (`http://localhost:5175` is in the auto-derived
					// dev-server allow-list).
					const res = yield* Effect.promise(() =>
						fetch(`${origin}${WalletHttpPath.ACCOUNTS}`, {
							headers: {
								Origin: 'http://localhost:5175',
								Authorization: `Bearer ${token!}`,
							},
						}),
					);
					expect(res.status).toBe(200);
					const body = (yield* Effect.promise(() => res.json())) as {
						accounts?: Array<{
							name: string;
							address: string;
							scheme: string;
							publicKey: string;
							source: string;
						}>;
					};
					expect(body.accounts).toHaveLength(1);
					const entry = body.accounts![0]!;
					expect(entry.name).toBe('frank');
					expect(entry.address).toBe(acct.account.address);
					expect(entry.scheme).toBe('ed25519');
					// `source` defaults to `'real'` for non-impersonation
					// accounts (Phase 4 P4.18).
					expect(entry.source).toBe('real');
					// publicKey is base64 of the raw 32 bytes for ed25519.
					expect(fromBase64(entry.publicKey)).toEqual(acct.account.publicKey);
				}).pipe(Effect.provide(stack as Layer.Layer<unknown, unknown, never>)),
			);
		}),
	);
});
