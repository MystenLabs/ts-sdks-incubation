import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';

import {
	awaitManagedProcessReady,
	describeProcessExitStatus,
	onceProcessError,
	onceProcessExit,
	terminateManagedProcess,
	type ManagedProcessChild,
} from '../../../src/substrate/runtime/process-supervisor.ts';

class FakeChild extends EventEmitter implements ManagedProcessChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.signals.push(signal);
		if (signal === 'SIGKILL') {
			setTimeout(() => this.emit('exit', null, signal), 0);
		}
		return true;
	}
}

describe('process supervisor helpers', () => {
	it('describes exit status without callers formatting it inline', () => {
		expect(describeProcessExitStatus({ code: 7, signal: null })).toBe('exit code 7');
		expect(describeProcessExitStatus({ code: null, signal: 'SIGTERM' })).toBe('signal SIGTERM');
		expect(describeProcessExitStatus({ code: null, signal: null })).toBe('unknown exit status');
	});

	it('races readiness against early process exit', async () => {
		const child = new FakeChild();
		const exit = onceProcessExit(child);
		const processError = onceProcessError(child);
		type ReadyFailure =
			| {
					readonly _tag: 'early-exit';
					readonly status: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
			  }
			| { readonly _tag: 'process-error'; readonly cause: unknown };
		setTimeout(() => child.emit('exit', 7, null), 0);

		const result = await Effect.runPromiseExit(
			awaitManagedProcessReady<ReadyFailure>({
				ready: Effect.promise(
					() => new Promise<void>((resolveReady) => setTimeout(resolveReady, 25)),
				),
				exit,
				processError,
				onExitBeforeReady: (status) => ({ _tag: 'early-exit', status }),
				onProcessErrorBeforeReady: (cause) => ({ _tag: 'process-error', cause }),
			}),
		);

		expect(Exit.isFailure(result)).toBe(true);
		const error = Exit.findErrorOption(result);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toEqual({
				_tag: 'early-exit',
				status: { code: 7, signal: null },
			});
		}
	});

	it('escalates from SIGTERM to SIGKILL after the grace window', async () => {
		const child = new FakeChild();
		let escalated = false;

		await Effect.runPromise(
			terminateManagedProcess(child, {
				graceMs: 1,
				onEscalate: () =>
					Effect.sync(() => {
						escalated = true;
					}),
			}),
		);

		expect(escalated).toBe(true);
		expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
	});

	it('can signal a POSIX process group instead of only the direct child', async () => {
		if (process.platform === 'win32') return;

		const child = new FakeChild();
		Object.defineProperty(child, 'pid', { value: 12_345 });
		const originalKill = process.kill;
		const signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			signals.push({ pid, signal: signal as NodeJS.Signals });
			if (signal === 'SIGKILL') {
				setTimeout(() => child.emit('exit', null, signal), 0);
			}
			return true;
		}) as typeof process.kill;

		try {
			await Effect.runPromise(
				terminateManagedProcess(child, {
					graceMs: 1,
					processGroup: true,
				}),
			);
		} finally {
			process.kill = originalKill;
		}

		expect(signals).toEqual([
			{ pid: -12_345, signal: 'SIGTERM' },
			{ pid: -12_345, signal: 'SIGKILL' },
		]);
		expect(child.signals).toEqual([]);
	});
});
