import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Option, type Scope } from 'effect';

import { definePlugin } from '../../../src/api/define-plugin.ts';
import { appName, chainId, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import { Logger, type LoggerShape } from '../../../src/substrate/runtime/observability/index.ts';
import { CurrentPluginKey } from '../../../src/substrate/runtime/current-plugin.ts';
import { IdentityContext, RuntimeRoot } from '../../../src/substrate/runtime/paths.ts';
import {
	PortBrokerService,
	type AllocateOptions,
	type PortBroker,
} from '../../../src/substrate/runtime/port-broker/index.ts';
import {
	acquireHostService,
	HOST_SERVICE_DEFAULT_ENDPOINT_NAME,
	HOST_SERVICE_PORT_TOKEN,
	HostServiceAcquireError,
	hostService,
	prepareHostService,
	makeHostServiceRoutable,
	normalizeHostServiceOptions,
	type HostProcessChild,
	type HostProcessSpawnOptions,
	type HostServiceResolvedOptions,
	type HostServiceValue,
} from '../../../src/plugins/host-service/index.ts';
import { logReady } from '../../../src/plugins/host-service/service.ts';
import {
	layerPostAcquireTasks,
	PostAcquireTasksService,
} from '../../../src/substrate/runtime/post-acquire-tasks.ts';

class FakeChild extends EventEmitter implements HostProcessChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: NodeJS.Signals[] = [];
	private exited = false;

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.signals.push(signal);
		this.emitExit(null, signal);
		return true;
	}

	emitExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.emit('exit', code, signal);
		this.stdout.end();
		this.stderr.end();
	}
}

interface SpawnCall {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly options: HostProcessSpawnOptions;
}

const loggerLines: Array<{ readonly message: string; readonly pluginKey: string | null }> = [];
const fakeLogger: LoggerShape = {
	log: (_tag, key, payload) =>
		Effect.sync(() => {
			loggerLines.push({ message: payload.message, pluginKey: key });
		}),
	readTag: () => Effect.succeed({ lines: [], truncated: false }),
	readAll: Effect.succeed(new Map()),
	clearTag: () => Effect.void,
};

const acquire = (
	options: HostServiceResolvedOptions,
	spawn: (
		command: string,
		args: ReadonlyArray<string>,
		options: HostProcessSpawnOptions,
	) => FakeChild,
) =>
	Effect.scoped(
		acquireHostService(options, {
			allocatePort: () => Effect.succeed(6173),
			logger: fakeLogger,
			pluginKey: pluginKey('host-service-test#0'),
			spawner: spawn,
			processEnv: { PATH: '/usr/bin' },
		}),
	);

const findFreePort = (): Promise<number> =>
	new Promise((resolvePort, rejectPort) => {
		const server = createServer();
		server.once('error', rejectPort);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => {
				if (typeof address === 'object' && address !== null) {
					resolvePort(address.port);
				} else {
					rejectPort(new Error('expected TCP server address with a port'));
				}
			});
		});
	});

const neededMember = definePlugin({
	id: 'test/needed',
	role: 'service',
	section: 'service',
	start: () => Effect.succeed({ ok: true } as const),
});

describe('hostService option validation', () => {
	it('rejects invalid preferred ports at the factory boundary', () => {
		expect(() => hostService({ command: 'pnpm', port: 0 })).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'port' }),
		);
		expect(() => hostService({ command: 'pnpm', port: 65_536 })).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'port' }),
		);
	});

	it('requires either command or script', () => {
		expect(() => hostService({} as never)).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'command' }),
		);
		expect(() => hostService({ command: 'pnpm', script: 'pnpm dev' } as never)).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'command' }),
		);
		expect(() => hostService({ script: 'pnpm dev', args: ['--watch'] } as never)).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'args' }),
		);
	});

	it('accepts script services for shell command lines', () => {
		const member = hostService({ script: `pnpm exec vite --port ${HOST_SERVICE_PORT_TOKEN}` });
		expect(member.dependsOn).toEqual([]);
	});

	it('validates script as a non-empty string', () => {
		expect(() => hostService({ script: '' })).toThrowError(
			expect.objectContaining({ _tag: 'HostServiceConfigError', field: 'script' }),
		);
	});
});

describe('hostService after', () => {
	it('keeps no-after services as dependency-free leaves', () => {
		const member = hostService({ command: 'pnpm' });
		expect(member.dependsOn).toEqual([]);
	});

	it('projects after members into dependencies for startup ordering', () => {
		const member = hostService({ command: 'pnpm', after: [neededMember] as const });
		expect(member.dependsOn).toEqual([neededMember]);
		expect(member.dependsOn[0]).toBe(neededMember);
	});
});

describe('acquireHostService', () => {
	it('allocates an HTTP port, renders command shape, and finalizes the child', async () => {
		loggerLines.length = 0;
		const child = new FakeChild();
		const calls: SpawnCall[] = [];
		const cwd = resolve('examples/deepbook-trader');
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			cwd,
			port: 5173,
			env: {
				VITE_PUBLIC_URL: `http://127.0.0.1:${HOST_SERVICE_PORT_TOKEN}`,
				PORT: 'user-value-gets-overridden',
			},
			ready: { kind: 'log', pattern: 'ready' },
		});
		const value = await Effect.runPromise(
			acquire(options, (command, args, spawnOptions) => {
				calls.push({ command, args, options: spawnOptions });
				setTimeout(() => child.stdout.write('vite ready\n'), 0);
				return child;
			}),
		);

		expect(value).toMatchObject({
			name: 'frontend',
			endpointName: 'dev',
			port: 6173,
			url: 'http://127.0.0.1:6173',
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error('expected one spawn call');
		expect(call.command).toBe('pnpm');
		expect(call.args).toEqual(['exec', 'vite', '--port', '6173']);
		expect(call.options.cwd).toBe(cwd);
		expect(call.options.env.PATH).toBe('/usr/bin');
		expect(call.options.env.VITE_PUBLIC_URL).toBe('http://127.0.0.1:6173');
		expect(call.options.env.PORT).toBe('6173');
		expect(call.options.detached).toBe(process.platform !== 'win32');
		expect(child.signals).toEqual(['SIGTERM']);
		await new Promise((resolveLogged) => setTimeout(resolveLogged, 0));
		expect(loggerLines).toContainEqual({
			message: 'vite ready',
			pluginKey: 'host-service-test#0',
		});
	});

	it('renders script services through the platform shell', async () => {
		const child = new FakeChild();
		const calls: SpawnCall[] = [];
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			script: `pnpm exec vite --host 127.0.0.1 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
			ready: { kind: 'log', pattern: 'ready' },
		});

		await Effect.runPromise(
			acquire(options, (command, args, spawnOptions) => {
				calls.push({ command, args, options: spawnOptions });
				setTimeout(() => child.stdout.write('ready\n'), 0);
				return child;
			}),
		);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error('expected one spawn call');
		if (process.platform === 'win32') {
			expect(call.args.slice(-1)).toEqual([
				'pnpm exec vite --host 127.0.0.1 --strictPort --port 6173',
			]);
		} else {
			expect(call.command).toBe('/bin/sh');
			expect(call.args).toEqual(['-c', 'pnpm exec vite --host 127.0.0.1 --strictPort --port 6173']);
		}
		expect(call.options.detached).toBe(process.platform !== 'win32');
	});

	it('can use stderr as the readiness log stream', async () => {
		const child = new FakeChild();
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite'],
			ready: { kind: 'log', pattern: 'ready', stream: 'stderr', timeoutMs: 1_000 },
		});

		const value = await Effect.runPromise(
			acquire(options, () => {
				setTimeout(() => child.stdout.write('ready on the wrong stream\n'), 0);
				setTimeout(() => child.stderr.write('vite ready\n'), 0);
				return child;
			}),
		);

		expect(value.url).toBe('http://127.0.0.1:6173');
	});

	it.live('readies an HTTP host-service when its health check returns 200', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const port = yield* Effect.promise(findFreePort);
				// A server that returns 200 at `/` satisfies the health-check
				// readiness contract and readies promptly.
				const options = normalizeHostServiceOptions({
					name: 'frontend',
					command: process.execPath,
					args: [
						'-e',
						[
							"const http = require('node:http');",
							'const server = http.createServer((_req, res) => {',
							'  res.statusCode = 200;',
							"  res.end('ready');",
							'});',
							"server.listen(Number(process.env.PORT), '127.0.0.1');",
						].join(' '),
					],
					ready: { kind: 'http', timeoutMs: 2_000, intervalMs: 50 },
				});

				const value = yield* acquireHostService(options, {
					allocatePort: () => Effect.succeed(port),
					logger: fakeLogger,
					pluginKey: pluginKey('host-service-test#0'),
					processEnv: { PATH: '/usr/bin' },
				});

				expect(value.url).toBe(`http://127.0.0.1:${port}`);
			}),
		),
	);

	it.live(
		'does NOT ready an HTTP host-service that never returns 200 (health check requires 200)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const port = yield* Effect.promise(findFreePort);
					// Readiness is a 200 health check. A server that is "listener up"
					// but only ever returns 500 (a dev server still compiling at `/`)
					// must NOT be treated as ready — it keeps polling and the acquire
					// fails at the readiness timeout. Pins the require-200 contract: a
					// listener-up `() => true` validator would wrongly pass here.
					const options = normalizeHostServiceOptions({
						name: 'frontend',
						command: process.execPath,
						args: [
							'-e',
							[
								"const http = require('node:http');",
								'const server = http.createServer((_req, res) => {',
								'  res.statusCode = 500;',
								"  res.end('compiling');",
								'});',
								"server.listen(Number(process.env.PORT), '127.0.0.1');",
							].join(' '),
						],
						ready: { kind: 'http', timeoutMs: 600, intervalMs: 50 },
					});

					const exit = yield* Effect.exit(
						acquireHostService(options, {
							allocatePort: () => Effect.succeed(port),
							logger: fakeLogger,
							pluginKey: pluginKey('host-service-test#1'),
							processEnv: { PATH: '/usr/bin' },
						}),
					);

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(Option.isSome(error)).toBe(true);
					if (Option.isSome(error)) {
						expect(error.value.phase).toBe('ready');
						expect(error.value.message).toContain('did not become ready');
					}
				}),
			),
	);

	it.live(
		'does NOT ready an HTTP host-service that only 3xx-redirects (redirects are not followed)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const port = yield* Effect.promise(findFreePort);
					// `redirect: 'manual'` — the readiness probe does NOT follow a 3xx.
					// A server that 302s at `/` (even to a would-be 200 target) must
					// NOT be treated as ready: the probed URL itself returned a
					// redirect, not a 200. Pins that fetch's default redirect-following
					// can't sneak a redirect target's 200 past the health check.
					const options = normalizeHostServiceOptions({
						name: 'frontend',
						command: process.execPath,
						args: [
							'-e',
							[
								"const http = require('node:http');",
								'const server = http.createServer((_req, res) => {',
								'  res.statusCode = 302;',
								"  res.setHeader('Location', '/ready');",
								"  res.end('redirecting');",
								'});',
								"server.listen(Number(process.env.PORT), '127.0.0.1');",
							].join(' '),
						],
						ready: { kind: 'http', timeoutMs: 600, intervalMs: 50 },
					});

					const exit = yield* Effect.exit(
						acquireHostService(options, {
							allocatePort: () => Effect.succeed(port),
							logger: fakeLogger,
							pluginKey: pluginKey('host-service-test#2'),
							processEnv: { PATH: '/usr/bin' },
						}),
					);

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(Option.isSome(error)).toBe(true);
					if (Option.isSome(error)) {
						expect(error.value.phase).toBe('ready');
					}
				}),
			),
	);

	it('fails acquire when the process emits an error before readiness', async () => {
		const child = new FakeChild();
		const cause = new Error('spawn failed');
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite'],
			ready: { kind: 'log', pattern: 'ready', timeoutMs: 1_000 },
		});

		const exit = await Effect.runPromiseExit(
			acquire(options, () => {
				setTimeout(() => child.emit('error', cause), 0);
				return child;
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBeInstanceOf(HostServiceAcquireError);
			expect(error.value).toMatchObject({
				serviceName: 'frontend',
				phase: 'spawn',
				cause,
			});
		}
	});

	it.effect('probes all interfaces when allocating the routed host-service port', () => {
		loggerLines.length = 0;
		const allocations: AllocateOptions[] = [];
		const broker: PortBroker = {
			allocate: (opts = {}) => {
				allocations.push(opts);
				return Effect.succeed({
					port: 6173,
					release: Effect.void,
				});
			},
		};
		const member = hostService({
			name: 'frontend',
			port: 5170,
			command: process.execPath,
			args: ['-e', `console.log('ready'); setInterval(() => {}, 1000);`],
			ready: { kind: 'log', pattern: 'ready', timeoutMs: 5_000 },
		});

		return Effect.scoped(
			Effect.gen(function* () {
				const start = member.start(undefined).pipe(
					Effect.provideService(PortBrokerService, broker),
					Effect.provideService(Logger, fakeLogger),
					Effect.provideService(CurrentPluginKey, { key: pluginKey('host-service-test#0') }),
					// The host-service start now reads Identity + RuntimeRoot to publish
					// DEVSTACK_STACK / DEVSTACK_RUNTIME_ROOT into the spawned child's env
					// (so the in-child Vite plugin re-discovers the active stack's manifest).
					Effect.provideService(IdentityContext, {
						app: appName('host-service-test'),
						stack: stackName('host-service-test'),
						chain: chainId('localnet'),
					}),
					Effect.provideService(RuntimeRoot, { root: '/tmp/host-service-test-root' }),
				) as Effect.Effect<HostServiceValue, unknown, Scope.Scope>;
				const value = yield* start;
				// With a real Identity in context the supervised host-service
				// publishes its CANONICAL routed URL (not the raw loopback bind):
				// role = endpointName (`dev`), stack ≠ `main` so it's included,
				// port = the shared Traefik entrypoint (5175). This is the URL the
				// dev-wallet CORS allowlist accepts — see `value.url` doc + the
				// wallet origin-policy. `.port` still reports the real bound
				// loopback port (6173) for readiness / direct host tooling.
				expect(value.url).toBe('http://dev.host-service-test.host-service-test.localhost:5175');
				expect(value.port).toBe(6173);
				expect(allocations).toEqual([
					{ owner: 'host-service:frontend', preferredPort: 5170, probeHost: '0.0.0.0' },
				]);
				const postAcquireTasks = yield* PostAcquireTasksService;
				yield* postAcquireTasks.runAll;
				yield* Effect.promise<void>(
					() => new Promise((resolveReady) => setTimeout(resolveReady, 0)),
				);
				expect(loggerLines).toContainEqual({
					message: 'ready',
					pluginKey: 'host-service-test#0',
				});
			}),
		).pipe(Effect.provide(layerPostAcquireTasks));
	});

	it.effect('starts a prepared process once', () => {
		const child = new FakeChild();
		const calls: SpawnCall[] = [];
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			ready: { kind: 'log', pattern: 'ready' },
		});

		return Effect.scoped(
			Effect.gen(function* () {
				const prepared = yield* prepareHostService(options, {
					allocatePort: () => Effect.succeed(6173),
					logger: fakeLogger,
					pluginKey: pluginKey('host-service-test#0'),
					spawner: (command, args, spawnOptions) => {
						calls.push({ command, args, options: spawnOptions });
						setTimeout(() => child.stdout.write('ready\n'), 0);
						return child;
					},
					processEnv: { PATH: '/usr/bin' },
				});

				expect(prepared.value.url).toBe('http://127.0.0.1:6173');
				expect(calls).toHaveLength(0);

				yield* prepared.start;
				expect(calls).toHaveLength(1);

				yield* prepared.start;
				expect(calls).toHaveLength(1);
			}),
		).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					expect(child.signals).toEqual(['SIGTERM']);
				}),
			),
		);
	});

	it.effect(
		'publishes the supplied routed URL as value.url while keeping the bound loopback port',
		() => {
			// The supervisor hands `routedUrl` (the canonical router-fronted
			// origin, e.g. `http://dev.<stack>.<app>.localhost:5175`) into the
			// acquire context so the host-service's published `value.url` is the
			// URL the dev-wallet CORS allowlist actually accepts. `.port` stays
			// the real bound loopback port for readiness / direct host tooling.
			const options = normalizeHostServiceOptions({
				name: 'frontend',
				command: 'pnpm',
				args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
				ready: { kind: 'log', pattern: 'ready' },
			});

			return Effect.scoped(
				Effect.gen(function* () {
					const prepared = yield* prepareHostService(options, {
						allocatePort: () => Effect.succeed(6173),
						logger: fakeLogger,
						pluginKey: pluginKey('host-service-test#0'),
						spawner: () => new FakeChild(),
						processEnv: { PATH: '/usr/bin' },
						routedUrl: 'http://dev.demo.demo.localhost:5175',
					});

					expect(prepared.value.url).toBe('http://dev.demo.demo.localhost:5175');
					expect(prepared.value.port).toBe(6173);
				}),
			);
		},
	);

	it.effect('falls back to the raw loopback value.url when no routed URL is supplied', () => {
		// No `routedUrl` (router disabled, or a hostname-validation failure in
		// the supervisor's best-effort derivation collapsed it to null) → the
		// raw `http://127.0.0.1:<port>` loopback bind remains the published URL,
		// exactly as before this change. A `null` routedUrl behaves identically
		// to an absent one.
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			ready: { kind: 'log', pattern: 'ready' },
		});

		return Effect.scoped(
			Effect.gen(function* () {
				const prepared = yield* prepareHostService(options, {
					allocatePort: () => Effect.succeed(6173),
					logger: fakeLogger,
					pluginKey: pluginKey('host-service-test#0'),
					spawner: () => new FakeChild(),
					processEnv: { PATH: '/usr/bin' },
					routedUrl: null,
				});

				expect(prepared.value.url).toBe('http://127.0.0.1:6173');
				expect(prepared.value.port).toBe(6173);
			}),
		);
	});

	it.effect('cleans failed readiness attempts and retries prepared start', () => {
		const children: FakeChild[] = [];
		const calls: SpawnCall[] = [];
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			ready: { kind: 'log', pattern: 'ready', timeoutMs: 5 },
		});

		return Effect.scoped(
			Effect.gen(function* () {
				const prepared = yield* prepareHostService(options, {
					allocatePort: () => Effect.succeed(6173),
					logger: fakeLogger,
					pluginKey: pluginKey('host-service-test#0'),
					spawner: (command, args, spawnOptions) => {
						const child = new FakeChild();
						children.push(child);
						calls.push({ command, args, options: spawnOptions });
						if (children.length === 2) {
							setTimeout(() => child.stdout.write('ready\n'), 0);
						}
						return child;
					},
					processEnv: { PATH: '/usr/bin' },
				});

				const first = yield* Effect.exit(prepared.start);
				expect(Exit.isFailure(first)).toBe(true);
				const firstError = Exit.findErrorOption(first);
				expect(Option.isSome(firstError)).toBe(true);
				if (Option.isSome(firstError)) {
					expect(firstError.value).toBeInstanceOf(HostServiceAcquireError);
				}
				expect(calls).toHaveLength(1);
				expect(children[0]?.signals).toEqual(['SIGTERM']);

				yield* prepared.start;
				expect(calls).toHaveLength(2);
			}),
		).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					expect(children[1]?.signals).toEqual(['SIGTERM']);
				}),
			),
		);
	});

	it.effect(
		'registers the child terminator atomically with spawn (interrupt mid-boot still tears the child down)',
		() => {
			// Regression for the spawn/finalizer atomicity bug: spawn, the
			// stdout/stderr line-drain fork, and the kill-finalizer
			// registration are wrapped together in a single
			// `Effect.uninterruptible` region, so the terminator is bound the
			// instant the spawn succeeds — no interrupt can land in the gap
			// between them. Here readiness never fires (a slow boot), the fiber
			// parks past the spawn in the readiness wait, and an interrupt
			// landing in exactly the old leak window must still run the
			// terminator. Pre-fix the finalizer was registered far below the
			// spawn (after the readiness wait), so an interrupt before that
			// point would leave the detached child alive with no SIGTERM.
			//
			// The terminator is registered AFTER the drain fork (not before, and
			// not via `acquireRelease`), so on scope close it runs before the
			// drains are interrupted: it kills the child, ending its streams,
			// which lets the non-interruptible `Stream.fromAsyncIterable` drains
			// drain-to-end. Registering it before the drains deadlocks teardown.
			const child = new FakeChild();
			const options = normalizeHostServiceOptions({
				name: 'frontend',
				command: 'pnpm',
				args: ['exec', 'vite'],
				// Pattern intentionally never emitted; large timeout so the
				// boot stays "in progress" for the whole test window.
				ready: { kind: 'log', pattern: 'never-emitted-readiness-token', timeoutMs: 60_000 },
			});

			return Effect.gen(function* () {
				const spawned = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkScoped(
					acquire(options, () => {
						// Signal the spawn happened without emitting readiness.
						Deferred.doneUnsafe(spawned, Effect.void);
						return child;
					}),
				);

				// Wait until the child is spawned, then let the forked fiber
				// park in `observeProcessLines` before interrupting — this is
				// the exact window the old ordering left unguarded.
				yield* Deferred.await(spawned);
				yield* Effect.yieldNow;

				yield* Fiber.interrupt(fiber);

				// Finalizer ran during scope teardown -> child was signalled,
				// no leaked detached process holding its port.
				expect(child.signals).toEqual(['SIGTERM']);
			});
		},
	);

	it('fails acquire when the process exits before readiness', async () => {
		const child = new FakeChild();
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite'],
			ready: { kind: 'log', pattern: 'ready', timeoutMs: 1_000 },
		});

		const exit = await Effect.runPromiseExit(
			acquire(options, () => {
				setTimeout(() => child.emitExit(7, null), 0);
				return child;
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBeInstanceOf(HostServiceAcquireError);
			expect(error.value).toMatchObject({
				serviceName: 'frontend',
				phase: 'exit',
				exitCode: 7,
				command: 'pnpm',
				args: ['exec', 'vite'],
			});
		}
	});
});

describe('logReady fallback wrapper preserves non-tagged causes', () => {
	// Regression for the `logReady` `Effect.tryPromise` catch arm: when the
	// log-readiness Promise rejects with a NON-tagged cause (a stream /
	// EventEmitter error rather than the pre-tagged timeout
	// `HostServiceAcquireError`), the catch MUST thread that raw cause
	// through the surfaced `HostServiceAcquireError.cause` instead of
	// dropping it and only preserving the closed-over template error.
	//
	// These cases DRIVE THE REAL `logReady` — we hand it a `readySignal`
	// Promise that rejects (the production `readySignal.then(onRejected)`
	// arm routes that rejection into the inner Promise's `rejectReady`) and
	// assert against the failure `logReady` actually surfaces. `exit` /
	// `processError` are never-resolving so the `ready` arm is the only one
	// that can win the race. Falsifiable: dropping the `cause:` threading in
	// service.ts, or dropping the new `readySignal` rejection wiring (so the
	// timeout would fire instead), breaks the first case; dropping the
	// `instanceof` short-circuit breaks the second.
	const never = <A>(): Promise<A> => new Promise<A>(() => {});

	const templateError = (): HostServiceAcquireError =>
		new HostServiceAcquireError({
			serviceName: 'frontend',
			cwd: '/cwd',
			command: 'pnpm',
			args: ['exec', 'vite'],
			phase: 'ready',
			message: 'host service readiness failed',
		});

	// A readiness signal whose rejection we control. We fork `logReady`
	// FIRST so its `Effect.tryPromise` body runs and attaches the
	// `readySignal.then(onFulfilled, onRejected)` handler, THEN reject —
	// this avoids both an unhandled-rejection window and any race over
	// which arm of `awaitManagedProcessReady` resolves first.
	const drive = (rejectWith: unknown) =>
		Effect.gen(function* () {
			let rejectSignal: ((cause: unknown) => void) | undefined;
			const readySignal = new Promise<void>((_resolve, reject) => {
				rejectSignal = reject;
			});
			const fiber = yield* Effect.forkChild(
				Effect.exit(
					logReady(
						{ kind: 'log', pattern: 'ready', timeoutMs: 60_000 },
						readySignal,
						never<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(),
						never<unknown>(),
						templateError(),
					),
				),
			);
			// Let the forked fiber step into `tryPromise` and attach its
			// rejection handler before we trip the signal.
			yield* Effect.yieldNow;
			rejectSignal?.(rejectWith);
			return yield* Fiber.join(fiber);
		});

	it.live('threads a non-tagged `cause` through the surfaced HostServiceAcquireError', () => {
		const rawCause = new Error('stream closed before readiness signal');
		return Effect.gen(function* () {
			const exit = yield* drive(rawCause);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				expect(error.value).toBeInstanceOf(HostServiceAcquireError);
				// Template fields are preserved...
				expect(error.value.serviceName).toBe('frontend');
				expect(error.value.phase).toBe('ready');
				expect(error.value.message).toBe('host service readiness failed');
				// ...and the load-bearing assertion: the raw, non-tagged cause is
				// threaded through (NOT dropped). This is the exact regression the
				// catch arm guards.
				expect(error.value.cause).toBe(rawCause);
			}
		});
	});

	it.live('passes a pre-tagged HostServiceAcquireError through unchanged', () => {
		// The timeout path produces a `HostServiceAcquireError` directly — the
		// catch arm must NOT re-wrap it (that would double-stamp the template
		// and bury the real message under `cause`). We drive this by rejecting
		// the readiness signal with an already-tagged error.
		const tagged = new HostServiceAcquireError({
			serviceName: 'frontend',
			cwd: '/cwd',
			command: 'pnpm',
			args: ['exec', 'vite'],
			phase: 'ready',
			message: 'host service did not emit readiness log within 5ms',
		});
		return Effect.gen(function* () {
			const exit = yield* drive(tagged);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				// Same identity — not re-wrapped, not buried under `.cause`.
				expect(error.value).toBe(tagged);
				expect(error.value.message).toContain('did not emit readiness log');
				expect(error.value.cause).toBeUndefined();
			}
		});
	});
});

describe('host service routable capability', () => {
	it('emits a host-loopback HTTP endpoint with the legacy default endpoint name', () => {
		const decl = makeHostServiceRoutable({
			endpointName: HOST_SERVICE_DEFAULT_ENDPOINT_NAME,
			serviceName: 'frontend',
			port: 6173,
		});

		expect(decl).toEqual({
			kind: 'routable',
			endpointName: 'dev',
			dispatchId: {
				serviceKey: 'host-service.frontend',
				role: 'dev',
			},
			upstream: { type: 'host-loopback', port: 6173 },
			cors: true,
			wireProtocol: 'http',
			readiness: 'deferred',
		});
	});
});
