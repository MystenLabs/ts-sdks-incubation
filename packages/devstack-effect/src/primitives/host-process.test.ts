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
import { Effect, Layer } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Identity } from '../internal/identity.js';
import { EndpointRegistryLive } from '../internal/registries.js';
import { hostProcess } from './host-process.js';

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
