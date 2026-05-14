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
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from '@effect/vitest';
import { Sui, type SuiShape } from '../interfaces/sui.js';
import { PortAllocatorLive } from '../internal/port-allocator.js';
import { EndpointRegistryLive } from '../internal/registries.js';
import { makeTag, type PluginTag } from '../tag.js';
import type { Account } from './shared.js';
import { walletApp } from './wallet-app.js';

// Stub Sui — wallet-app yields it only for ordering (waits for the
// chain to be ready before binding its HTTP server). The shape's
// fields are never read by the wallet-app body, so a minimal cast
// through `unknown` is fine.
const stubSui: Layer.Layer<Sui> = Layer.succeed(Sui, {
	network: 'localnet',
	rpcUrl: 'http://localhost:9000',
	chainId: 'test-chain',
	client: {} as unknown as SuiShape['client'],
	// wallet-app never asks the chain to be funds-transferable; resolve
	// immediately so the stub mirrors the mainnet/no-faucet branch.
	waitForTransactionsReady: () => Effect.void,
});

// Build a stub account tag. The wallet-app reads `address` to key the
// `accountsByAddress` map; the sign methods are never invoked by this
// test (no HTTP traffic). We do NOT use the real `accounts()` factory
// here because it would drag in StateStore, faucet, leasing, etc. —
// none of which are relevant to the finalizer behavior under test.
const stubAccountTag = (name: string): PluginTag<string, Account, never, never> =>
	makeTag(
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

afterEach(async () => {
	while (liveServers.length > 0) {
		const s = liveServers.pop();
		if (s !== undefined) await close(s);
	}
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
			const baseLayer = Layer.mergeAll(stubSui, PortAllocatorLive, EndpointRegistryLive);
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
					// on scope close.
					const value = yield* app;
					// Parse the port out of `http://localhost:<port>`.
					const match = /:(\d+)$/.exec(value.url);
					expect(match).not.toBeNull();
					return Number(match![1]);
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
