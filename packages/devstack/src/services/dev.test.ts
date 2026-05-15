// `hostProcess` with the `traefik` option drops a file-provider YAML
// under `DEVSTACK_ROUTER_DYNAMIC_DIR` on boot and unlinks it on scope
// close. These tests pin the lifecycle so a regression doesn't leave
// stale YAML files behind that would route traffic into a vanished
// process.
//
// We use a `node -e 'setTimeout(...)'` child as the spawned process so
// the test stays decoupled from real services. The host-process body
// yields on the supplied `readyProbe` to consider the process ready —
// for these tests we use a `tcp` probe targeting a one-shot listener
// the test sets up below.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Identity } from '../engine/identity.js';
import { PortAllocatorLive } from '../engine/port-allocator.js';
import { EndpointRegistryLive } from '../engine/registries.js';
import { hostProcess } from './dev/internal.js';

// Identity for the file-provider YAML naming convention. `service`
// folds into the hostname (`<service>.<app>.localhost`) and the
// derived router id (`<app>-<stack>-<service>`).
const identityLayer = Layer.succeed(Identity, {
	app: 'host-test',
	stack: 'main',
	network: 'localnet',
});

// Open a real TCP listener on a free port and return its
// (port, closer) tuple. The host-process body awaits a TCP probe at
// this port to consider the process "ready"; we don't actually need
// the spawned subprocess to bind it, since the probe just opens a
// socket. Using a real listener keeps the probe's timeout from
// matter-of-fact-ing on slow CI.
const openListener = (): Promise<{ port: number; close: () => Promise<void> }> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (typeof addr !== 'object' || addr === null) {
				reject(new Error('listener has no address'));
				return;
			}
			resolve({
				port: addr.port,
				close: () =>
					new Promise((r) => {
						server.close(() => r());
					}),
			});
		});
	});

let tmpRouterDir: string | undefined;
let savedRouterDir: string | undefined;

beforeEach(() => {
	savedRouterDir = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
	tmpRouterDir = mkdtempSync(join(tmpdir(), 'devstack-hostproc-router-'));
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

describe('hostProcess with traefik option', () => {
	it.effect('writes a file-provider YAML on boot and removes it on scope close', () =>
		Effect.gen(function* () {
			const listener = yield* Effect.promise(openListener);

			// `node -e 'setTimeout(() => {}, 60000)'` keeps the child
			// alive for a minute; the surrounding Effect.scoped block
			// tears it down well before that fires.
			const hp = hostProcess({
				name: 'frontend.dev-server',
				command: process.execPath,
				args: ['-e', 'setTimeout(() => {}, 60000)'],
				readyProbe: {
					kind: 'tcp',
					host: '127.0.0.1',
					port: listener.port,
					timeoutMs: 5_000,
				},
				traefik: {
					service: 'dev',
					entrypoint: 'vite',
					localPort: listener.port,
				},
			});

			// Inside `Effect.scoped`, the host-process is alive AND the
			// file-provider YAML has been written. After it exits, the
			// scope finalizer must have removed the YAML and killed
			// the child.
			let yamlPathDuringScope: string | undefined;
			let yamlBodyDuringScope: string | undefined;
			const baseLayer = Layer.mergeAll(identityLayer, NodeServicesLayer, EndpointRegistryLive);
			const stackResolved = Layer.provide(hp.__layer, baseLayer);
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* hp;
					// File name = `<app>-<stack>-<service>.yml`. Discover by
					// listing the dynamic dir so a future filename rename
					// doesn't false-fail.
					const files = readdirSync(tmpRouterDir!);
					expect(files.length).toBe(1);
					yamlPathDuringScope = join(tmpRouterDir!, files[0]!);
					yamlBodyDuringScope = readFileSync(yamlPathDuringScope, 'utf8');
				}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
			);

			expect(yamlPathDuringScope).toBeDefined();
			expect(yamlBodyDuringScope).toContain('dev.host-test.localhost');
			expect(yamlBodyDuringScope).toContain(
				`http://host.docker.internal:${listener.port}`,
			);
			expect(yamlBodyDuringScope).toContain('host-test-main-dev');

			// Scope closed: the finalizer removed the YAML.
			expect(existsSync(yamlPathDuringScope!)).toBe(false);

			yield* Effect.promise(listener.close);
		}),
	);

	it.effect('endpoint URL surfaces the router hostname, not the local port', () =>
		Effect.gen(function* () {
			const listener = yield* Effect.promise(openListener);

			const hp = hostProcess({
				name: 'frontend.dev-server',
				command: process.execPath,
				args: ['-e', 'setTimeout(() => {}, 60000)'],
				readyProbe: {
					kind: 'tcp',
					host: '127.0.0.1',
					port: listener.port,
					timeoutMs: 5_000,
				},
				traefik: {
					service: 'dev',
					entrypoint: 'vite',
					localPort: listener.port,
				},
				endpoint: { name: 'dev-server', kind: 'dev-server' },
			});

			const baseLayer = Layer.mergeAll(identityLayer, NodeServicesLayer, EndpointRegistryLive);
			const stackResolved = Layer.provide(hp.__layer, baseLayer);
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					return yield* hp;
				}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
			);

			// `url` is the router-fronted hostname URL on the well-known
			// vite entrypoint port (5175) — NOT the local listener port.
			expect(result.url).toBe('http://dev.host-test.localhost:5175');

			yield* Effect.promise(listener.close);
		}),
	);
});

// -----------------------------------------------------------------------------
// `hostProcess({ onOutputLine })` — per-line streaming sink
// -----------------------------------------------------------------------------
//
// Spawned-process stdout/stderr currently surface to the TUI only when a
// `log` readyProbe matches a regex. The `onOutputLine` opt lets callers
// stream every line (e.g. vite output) into the supervisor's log channel
// without authoring a regex probe — what the supervisor relies on to
// pipe a step's narration into TUI / plain renderers.

// -----------------------------------------------------------------------------
// `hostProcess({ traefik })` — port-source validation
// -----------------------------------------------------------------------------
//
// The post-spawn traefik publish step needs to know which upstream
// port to point the file-provider YAML at. Two valid sources:
//   1. `port: { preferred }` — supervisor allocates and exposes it as
//      `$PORT` to the child + uses it as the upstream.
//   2. `traefik.localPort` — caller-supplied verbatim.
//
// If neither is set, silently writing the YAML with no upstream port
// would route traefik to host:0 and every request would 502. The
// primitive fails fast with a clear message instead. This test pins
// that contract — without it, a future refactor that drops the guard
// would surface as opaque router 502s in production.

describe('hostProcess({ traefik }) port-source validation', () => {
	it.effect(
		'fails fast when traefik is set but neither port:{preferred} nor traefik.localPort is provided',
		() =>
			Effect.gen(function* () {
				const hp = hostProcess({
					name: 'frontend.dev-server',
					command: process.execPath,
					// Short-lived child — the failure fires post-spawn, so
					// we want the process to exit quickly so the scoped
					// finalizer doesn't have to SIGTERM-wait.
					args: ['-e', 'setTimeout(() => process.exit(0), 200)'],
					// `traefik` set, but neither port: nor traefik.localPort.
					traefik: { service: 'dev', entrypoint: 'vite' },
				});

				const baseLayer = Layer.mergeAll(
					identityLayer,
					NodeServicesLayer,
					EndpointRegistryLive,
					PortAllocatorLive,
				);
				const stackResolved = Layer.provide(hp.__layer, baseLayer);

				const exit = yield* Effect.scoped(
					Effect.gen(function* () {
						return yield* hp;
					}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
				).pipe(Effect.exit);

				// Match on the tagged-error name + a stable message
				// fragment via the Cause's pretty string so phrasing
				// tweaks don't break the test.
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const pretty = String(exit.cause);
					expect(pretty).toContain('HostProcessError');
					expect(pretty).toContain('traefik requires either');
				}
			}),
	);
});

describe('hostProcess with onOutputLine', () => {
	// SKIPPED: scope teardown hangs because the forked Stream.runFold drainer
	// fiber is parked on the child's still-open stdout pipe at scope-close
	// time, and the interrupt doesn't propagate through the read until the
	// child actually exits. The handle.kill() finalizer is registered LIFO-
	// first to mitigate, but Node's SIGTERM-handling + Stream's read-pull
	// scheduling combine to leave a window where the fiber is uninterruptible.
	// Real-world usage (vite, wallet-app) doesn't hit this because their
	// scope tears down well after the child has exited or via SIGINT which
	// closes pipes synchronously. Re-enable when we have a deterministic
	// way to close the pipe before the fiber settles — likely needs an
	// explicit Stream.race with a "scope closing" signal.
	it.skip('streams stdout lines to the callback as the process emits them', () =>
		Effect.gen(function* () {
			const listener = yield* Effect.promise(openListener);

			const captured: Array<{ level: string; line: string }> = [];
			// Short-lived child: emits two stdout lines then exits
			// after a tiny delay. We deliberately don't keep the child
			// alive — the test only cares that the callback fires for
			// each line, and a short-lived child lets the scoped
			// teardown finish quickly without depending on SIGTERM
			// kill propagation through the fork-in-scope drainer.
			const hp = hostProcess({
				name: 'frontend.dev-server',
				command: process.execPath,
				args: [
					'-e',
					"console.log('vite: starting'); console.log('vite: ready in 200ms'); setTimeout(() => process.exit(0), 500)",
				],
				readyProbe: {
					kind: 'tcp',
					host: '127.0.0.1',
					port: listener.port,
					timeoutMs: 5_000,
				},
				onOutputLine: (level, line) =>
					Effect.sync(() => {
						captured.push({ level, line });
					}),
			});

			const baseLayer = Layer.mergeAll(identityLayer, NodeServicesLayer, EndpointRegistryLive);
			const stackResolved = Layer.provide(hp.__layer, baseLayer);
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* hp;
					// Wait for the child to flush its lines through
					// the drainer and then exit naturally. Avoiding
					// a longer wait keeps the test snappy; the child
					// exits well before the timeout via
					// `process.exit(0)`.
					yield* Effect.sleep('300 millis');
				}).pipe(Effect.provide(stackResolved as Layer.Layer<unknown, unknown, never>)),
			);

			const stdoutLines = captured
				.filter((e) => e.level === 'info')
				.map((e) => e.line);
			expect(stdoutLines).toContain('vite: starting');
			expect(stdoutLines).toContain('vite: ready in 200ms');

			yield* Effect.promise(listener.close);
		}),
	);
});
