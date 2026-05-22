import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { Effect } from 'effect';

export interface ManagedProcessExitStatus {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface ManagedProcessChild {
	readonly pid?: number;
	readonly stdout?: Readable | null;
	readonly stderr?: Readable | null;
	readonly exitCode?: number | null;
	readonly signalCode?: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: 'error', listener: (cause: Error) => void): this;
	once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: 'error', listener: (cause: Error) => void): this;
	off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: 'error', listener: (cause: Error) => void): this;
}

export interface ManagedProcessSpawnOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stdio: 'pipe';
}

export type ManagedProcessSpawner = (
	command: string,
	args: ReadonlyArray<string>,
	options: ManagedProcessSpawnOptions,
) => ManagedProcessChild;

export const nodeProcessSpawner: ManagedProcessSpawner = (command, args, options) =>
	spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio,
	}) as ManagedProcessChild;

export const describeProcessExitStatus = (status: ManagedProcessExitStatus): string => {
	if (status.code !== null) return `exit code ${status.code}`;
	if (status.signal !== null) return `signal ${status.signal}`;
	return 'unknown exit status';
};

export const onceProcessExit = (child: ManagedProcessChild): Promise<ManagedProcessExitStatus> =>
	new Promise((resolveExit) => {
		child.once('exit', (code, signal) => resolveExit({ code, signal }));
	});

export const getProcessExitStatus = (
	child: ManagedProcessChild,
): ManagedProcessExitStatus | null => {
	if (child.exitCode !== undefined && child.exitCode !== null) {
		return { code: child.exitCode, signal: null };
	}
	if (child.signalCode !== undefined && child.signalCode !== null) {
		return { code: null, signal: child.signalCode };
	}
	return null;
};

export const awaitProcessExit = (child: ManagedProcessChild): Promise<ManagedProcessExitStatus> =>
	Promise.resolve(getProcessExitStatus(child) ?? onceProcessExit(child));

export const onceProcessError = (child: ManagedProcessChild): Promise<unknown> =>
	new Promise((resolveError) => {
		child.once('error', (cause) => resolveError(cause));
	});

export const waitForProcessExitOrTimeout = (
	child: ManagedProcessChild,
	timeoutMs: number,
): Promise<ManagedProcessExitStatus | null> =>
	Promise.race([
		onceProcessExit(child),
		new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), timeoutMs)),
	]);

export interface TerminateManagedProcessOptions {
	readonly graceMs: number;
	readonly killTimeoutMs?: number;
	readonly onEscalate?: () => Effect.Effect<void>;
}

export const terminateManagedProcess = (
	child: ManagedProcessChild,
	options: TerminateManagedProcessOptions,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const exited = waitForProcessExitOrTimeout(child, options.graceMs);
		yield* Effect.sync(() => {
			child.kill('SIGTERM');
		});
		const first = yield* Effect.promise(() => exited);
		if (first !== null) return;
		if (options.onEscalate !== undefined) {
			yield* options.onEscalate().pipe(Effect.ignore);
		}
		const killed = waitForProcessExitOrTimeout(child, options.killTimeoutMs ?? 1_000);
		yield* Effect.sync(() => {
			child.kill('SIGKILL');
		});
		yield* Effect.promise(() => killed);
	});

export interface AwaitManagedProcessReadyOptions<E, R = never> {
	readonly ready: Effect.Effect<void, E, R>;
	readonly exit: Promise<ManagedProcessExitStatus>;
	readonly processError: Promise<unknown>;
	readonly onExitBeforeReady: (status: ManagedProcessExitStatus) => E;
	readonly onProcessErrorBeforeReady: (cause: unknown) => E;
}

export const awaitManagedProcessReady = <E, R = never>(
	options: AwaitManagedProcessReadyOptions<E, R>,
): Effect.Effect<void, E, R> =>
	Effect.raceFirst(
		options.ready,
		Effect.raceFirst(
			Effect.promise(() => options.exit).pipe(
				Effect.flatMap((status) => Effect.fail(options.onExitBeforeReady(status))),
			),
			Effect.promise(() => options.processError).pipe(
				Effect.flatMap((cause) => Effect.fail(options.onProcessErrorBeforeReady(cause))),
			),
		),
	);
