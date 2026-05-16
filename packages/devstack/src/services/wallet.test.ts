// The wallet-app's finalizer is the only thing between a dev session
// teardown and `EADDRINUSE` on the next session's wallet server. The
// load-bearing pieces:
//
//   1. `server.closeAllConnections()` — Node 18.2+ method that
//      terminates keep-alive sockets that would otherwise block the
//      port for an indefinite drain window.
//   2. `await server.close(cb)` — the finalizer must NOT resume the
//      surrounding Effect until close has fully completed; resuming
//      early would race the OS releasing the bound socket.
//   3. `allocator.release(port)` — must happen AFTER close so a
//      subsequent allocate(port) doesn't reuse a number whose socket
//      hasn't fully torn down.
//
// This test forces the finalizer to run (by yielding the wallet-app
// inside an `Effect.scoped` block), then proves the port is actually
// free by binding a real `net.Server` to the SAME 127.0.0.1:port. If
// any of (1)-(3) regresses, the bind fails with EADDRINUSE.

import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { SuiTag, type Sui } from '../services/sui.js';
import { Identity } from '../engine/identity.js';
import { PortAllocatorLive } from '../engine/port-allocator.js';
import { EndpointRegistryLive } from '../engine/registries.js';
import { tag, type Ref } from '../advanced/tag.js';
import type { Account } from '../engine/shared.js';
import { walletApp } from './wallet/internal.js';

// Stub Sui — wallet-app yields it only for ordering (waits for the
// chain to be ready before binding its HTTP server). The shape's
// fields are never read by the wallet-app body, so a minimal cast
// through `unknown` is fine.
const stubSui: Layer.Layer<SuiTag> = Layer.succeed(SuiTag, {
	network: 'localnet',
	rpc: { host: 'http://localhost:9000' },
	chainId: 'test-chain',
	client: {} as unknown as Sui['client'],
	// wallet-app never asks the chain to be funds-transferable; resolve
	// immediately so the stub mirrors the mainnet/no-faucet branch.
	waitForTransactionsReady: () => Effect.void,
});

// Build a stub account tag. The wallet-app reads `address` to key the
// `accountsByAddress` map; the sign methods are never invoked by this
// test (no HTTP traffic). We do NOT use the real `accounts()` factory
// here because it would drag in StateStore, faucet, leasing, etc. —
// none of which are relevant to the finalizer behavior under test.
const stubAccountTag = (name: string): Ref<string, Account, never, never> =>
	tag(
		name,
		Effect.succeed({
			name,
			address: '0xstub',
			publicKey: new Uint8Array(32),
			scheme: 'ED25519',
			signAndExecute: () =>
				Effect.die('stub account: signAndExecute should not be called in this test'),
			signTransaction: () =>
				Effect.die('stub account: signTransaction should not be called in this test'),
			signPersonalMessage: () =>
				Effect.die('stub account: signPersonalMessage should not be called in this test'),
		} as Account),
	);

// Open a real TCP listener on (port, '127.0.0.1') and resolve when
// it's bound. Rejects on error so a still-held port surfaces as a
// test assertion rather than a timeout.
const tryBindLoopback = (port: number): Promise<net.Server> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.once('listening', () => resolve(server));
		server.listen(port, '127.0.0.1');
	});

const close = (server: net.Server): Promise<void> =>
	new Promise((resolve) => {
		(server as { closeAllConnections?: () => void }).closeAllConnections?.();
		server.close(() => resolve());
	});

const liveServers: Array<net.Server> = [];

// The router file-provider helper writes YAML under
// `DEVSTACK_ROUTER_DYNAMIC_DIR ?? ~/.devstack/traefik/dynamic`. Point it
// at a tmpdir for each test so we don't touch the user's real dynamic
// directory, and so the post-test cleanup is contained.
let savedRouterDir: string | undefined;
let tmpRouterDir: string | undefined;

beforeEach(() => {
	savedRouterDir = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
	tmpRouterDir = mkdtempSync(join(tmpdir(), 'devstack-wallet-router-'));
	process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = tmpRouterDir;
});

afterEach(async () => {
	while (liveServers.length > 0) {
		const s = liveServers.pop();
		if (s !== undefined) await close(s);
	}
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

// Identity layer for the wallet-app test — the router-hostname helper
// reads `(app, stack, network)` to compose the public hostname.
const identityLayer = Layer.succeed(Identity, {
	app: 'wallet-test',
	stack: 'main',
	network: 'localnet',
});

describe('walletApp router hostname', () => {
	it.effect('endpoint URL uses the stack-scoped router hostname on the wallet entrypoint port', () =>
		Effect.gen(function* () {
			const acct = stubAccountTag('alice');
			const PREFERRED = 41_817;
			const app = walletApp({ accounts: [acct], port: PREFERRED });
			const baseLayer = Layer.mergeAll(
				stubSui,
				identityLayer,
				PortAllocatorLive,
				EndpointRegistryLive,
			);
			const userLayer = Layer.provideMerge(app.__layer, acct.__layer);
			const stackResolved = Layer.provide(userLayer, baseLayer);

			const value = yield* Effect.scoped(
				Effect.gen(function* () {
					return yield* app;
				}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
			);

			// Identity-derived router URL: `wallet.<app>.localhost:5180`
			// (main stack). The pairing token is preserved on `pairUrl`.
			expect(value.url).toBe('http://wallet.wallet-test.localhost:5180');
			expect(value.pairUrl.startsWith('http://wallet.wallet-test.localhost:5180/?token=')).toBe(
				true,
			);
			// `localPort` carries the actual 127.0.0.1 binding for callers
			// that need it (e.g. the finalizer test below).
			expect(typeof value.localPort).toBe('number');
		}),
	);
});

describe('walletApp finalizer', () => {
	it.effect('releases its bound port so a subsequent 127.0.0.1 listener succeeds', () =>
		// `Effect.scoped` forces the wallet-app's finalizer to run when
		// the inner effect completes. We capture the bound port BEFORE
		// the scope closes, then try to claim it from a brand-new
		// `net.createServer().listen(port, '127.0.0.1')` AFTER. If the
		// finalizer's `closeAllConnections()` + `await close(cb)`
		// regresses, the bind throws EADDRINUSE.
		Effect.gen(function* () {
			const acct = stubAccountTag('alice');
			// Pick a preferred port that's almost certainly free. The
			// allocator scans forward if it's not, so the actual bound
			// port may differ — we read it off the wallet-app value.
			const PREFERRED = 41_815;
			const app = walletApp({ accounts: [acct], port: PREFERRED });
			// Build the wallet-app's layer (its own + the inner account
			// tag's transitively-flattened layers) and provide every
			// service it needs: Sui, PortAllocator, EndpointRegistry.
			const baseLayer = Layer.mergeAll(
				stubSui,
				identityLayer,
				PortAllocatorLive,
				EndpointRegistryLive,
			);
			// The wallet-app's body `yield* acc` for each account tag,
			// so the account layer has to be VISIBLE inside the
			// wallet-app's R-channel. `provideMerge(self, that)` provides
			// `that`'s outputs to `self` AND re-exports both — the same
			// shape `composeStackLayer` uses to fold the user stack.
			const userLayer = Layer.provideMerge(app.__layer, acct.__layer);
			const stackResolved = Layer.provide(userLayer, baseLayer);

			const boundPort = yield* Effect.scoped(
				Effect.gen(function* () {
					// Yield the wallet-app tag — its build runs inside the
					// surrounding `Effect.scoped`, so the finalizer fires
					// on scope close. The PUBLIC `url` now surfaces the
					// router hostname + entrypoint port (`wallet.<app>.localhost:5180`),
					// so we read `localPort` for the local 127.0.0.1
					// bind the finalizer is supposed to release.
					const value = yield* app;
					return value.localPort;
				}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
			);

			expect(Number.isFinite(boundPort)).toBe(true);

			// The wallet-app's scope has closed — the finalizer should
			// have closed the server AND awaited the close callback
			// before releasing the allocator slot. Prove the port is
			// genuinely free by binding it ourselves on the same
			// interface (127.0.0.1) that wallet-app bound on.
			const server = yield* Effect.tryPromise({
				try: () => tryBindLoopback(boundPort),
				catch: (cause) =>
					new Error(
						`port ${boundPort} was not re-bindable after wallet-app teardown: ${String(cause)}`,
					),
			});
			liveServers.push(server);
			// If we got here, the OS handed us the same port — the
			// finalizer's port-release protocol is correct.
			expect(server.listening).toBe(true);
		}),
	);
});
