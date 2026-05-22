import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';

import { definePlugin } from '../../../src/api/define-plugin.ts';
import { pluginKey } from '../../../src/substrate/brand.ts';
import type { LoggerShape } from '../../../src/substrate/runtime/observability/index.ts';
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
} from '../../../src/plugins/host-service/index.ts';
import {
	PostAcquireTasksService,
	PostAcquireTaskFailed,
	layerPostAcquireTasks,
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

const neededMember = definePlugin({
	id: 'test/needed',
	role: 'service',
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

	it.effect('defers process spawn through the post-acquire task barrier', () => {
		const child = new FakeChild();
		const calls: SpawnCall[] = [];
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			ready: { kind: 'log', pattern: 'ready' },
		});

		return Effect.gen(function* () {
			const tasks = yield* PostAcquireTasksService;
			yield* Effect.scoped(
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

					yield* tasks.register({
						pluginKey: pluginKey('host-service-test#0'),
						label: 'host-service/frontend',
						run: prepared.start,
					});

					expect(prepared.value.url).toBe('http://127.0.0.1:6173');
					expect(calls).toHaveLength(0);

					yield* tasks.runAll;
					expect(calls).toHaveLength(1);

					yield* tasks.runAll;
					expect(calls).toHaveLength(1);
				}),
			);
			expect(child.signals).toEqual(['SIGTERM']);
		}).pipe(Effect.provide(layerPostAcquireTasks));
	});

	it.effect('cleans failed readiness attempts and retries the deferred start', () => {
		const children: FakeChild[] = [];
		const calls: SpawnCall[] = [];
		const options = normalizeHostServiceOptions({
			name: 'frontend',
			command: 'pnpm',
			args: ['exec', 'vite', '--port', HOST_SERVICE_PORT_TOKEN],
			ready: { kind: 'log', pattern: 'ready', timeoutMs: 5 },
		});

		return Effect.gen(function* () {
			const tasks = yield* PostAcquireTasksService;
			yield* Effect.scoped(
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

					yield* tasks.register({
						pluginKey: pluginKey('host-service-test#0'),
						label: 'host-service/frontend',
						run: prepared.start,
					});

					const first = yield* Effect.exit(tasks.runAll);
					expect(Exit.isFailure(first)).toBe(true);
					const firstError = Exit.findErrorOption(first);
					expect(Option.isSome(firstError)).toBe(true);
					if (Option.isSome(firstError)) {
						expect(firstError.value).toBeInstanceOf(PostAcquireTaskFailed);
						expect(firstError.value.pluginKey).toBe('host-service-test#0');
					}
					expect(calls).toHaveLength(1);
					expect(children[0]?.signals).toEqual(['SIGTERM']);

					yield* tasks.runAll;
					expect(calls).toHaveLength(2);
				}),
			);
			expect(children[1]?.signals).toEqual(['SIGTERM']);
		}).pipe(Effect.provide(layerPostAcquireTasks));
	});

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
		});
	});
});
