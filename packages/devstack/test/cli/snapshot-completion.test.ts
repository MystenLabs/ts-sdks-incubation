import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';
import {
	commandChannelPaths,
	makeCommandChannelSubscriber,
} from '../../src/substrate/runtime/cross-process/index.ts';
import { processStartTime } from '../../src/substrate/runtime/cross-process/liveness.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoots: Array<string> = [];

const makeTempRoot = (prefix: string): string => {
	const root = mkdtempSync(join(packageRoot, `.tmp-${prefix}-`));
	tempRoots.push(root);
	return root;
};

const writeLiveRoster = (stackRoot: string): void => {
	mkdirSync(stackRoot, { recursive: true });
	writeFileSync(
		join(stackRoot, 'roster.json'),
		JSON.stringify({
			version: 1,
			holders: [
				{
					pid: process.pid,
					startTime: processStartTime(process.pid) ?? 0,
					hostname: nodeHostname(),
					claimedAt: Date.now(),
					heartbeatAt: Date.now(),
					intent: 'normal',
				},
			],
		}),
		'utf8',
	);
};

const captureProcessWrite =
	(bucket: Array<string>): typeof process.stdout.write =>
	(chunk, encodingOrCallback?, callback?) => {
		bucket.push(String(chunk));
		if (typeof encodingOrCallback === 'function') {
			encodingOrCallback();
		}
		if (typeof callback === 'function') {
			callback();
		}
		return true;
	};

describe('cli/main snapshot completion event matcher', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores a peer CLI's captureSkipped event carrying a different snapshotId", async () => {
		const stateRoot = makeTempRoot('cli-skip-misattribution-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
		const previousExitCode = process.exitCode;
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		writeLiveRoster(stackRoot);

		// Stand in for the supervisor: when our `snapshot.capture` command
		// lands, first emit a PEER's captureSkipped (different snapshotId) to
		// simulate a concurrent CLI session whose request was refused, THEN
		// emit `snapshot.captured` correlated to OUR snapshotId. The CLI must
		// ignore the peer skip and complete on our captured event.
		const subscriberFiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(stackRoot), {
						fromOffset: 'start',
						pollMillis: 20,
					});
					yield* subscriber.commands.pipe(
						Stream.take(1),
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								const command = record.command as {
									readonly tag?: string;
									readonly snapshotId?: string;
									readonly name?: string;
								};
								// Peer skip — different snapshotId. MUST NOT terminate us.
								// The CLI wiring no longer tails the event stream for
								// completion; the peer skip is a pure observability event
								// that the new wiring ignores.
								yield* subscriber.publishEvent({
									tag: 'snapshot.captureSkipped',
									reason: 'already-running',
									snapshotId: 'snap-peer-00000000',
									at: Date.now(),
								});
								// Our captured — correlated to OUR snapshotId.
								if (command.snapshotId !== undefined) {
									yield* subscriber.publishEvent({
										tag: 'snapshot.captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
										at: Date.now(),
									});
								}
								// New protocol: ack carries the structured capture payload.
								// `awaitCompletion` surfaces this directly so the CLI does
								// not need to tail the events stream.
								yield* subscriber.ack(record.id, 'captured', {
									kind: 'captured',
									snapshotId: command.snapshotId,
									...(command.name === undefined ? {} : { name: command.name }),
								});
							}),
						),
					);
				}),
			),
		);

		try {
			process.exitCode = undefined;
			await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));

			await runCli([
				'snapshot',
				'save',
				'mine',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly snapshotId: string; readonly name: string };
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data.name).toBe('mine');
			expect(envelope.data.snapshotId).toMatch(/^snap-\d+-[0-9a-f]{8}$/);
			expect(envelope.data.snapshotId).not.toBe('snap-peer-00000000');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);

	it('surfaces "already running" when the supervisor skips OUR snapshotId', async () => {
		const stateRoot = makeTempRoot('cli-skip-own-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
		const previousExitCode = process.exitCode;
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		writeLiveRoster(stackRoot);

		const subscriberFiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(stackRoot), {
						fromOffset: 'start',
						pollMillis: 20,
					});
					yield* subscriber.commands.pipe(
						Stream.take(1),
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								const command = record.command as {
									readonly tag?: string;
									readonly snapshotId?: string;
								};
								if (command.snapshotId !== undefined) {
									yield* subscriber.publishEvent({
										tag: 'snapshot.captureSkipped',
										reason: 'already-running',
										snapshotId: command.snapshotId,
										at: Date.now(),
									});
								}
								// New protocol: a skip is now reported via `fail` with a
								// structured payload (kind=skipped) so the CLI surfaces a
								// `CliUnavailableError` rather than a successful ack.
								yield* subscriber.fail(
									record.id,
									'snapshot capture skipped',
									'already-running',
									{
										kind: 'skipped',
										snapshotId: command.snapshotId,
										reason: 'already-running',
									},
								);
							}),
						),
					);
				}),
			),
		);

		try {
			process.exitCode = undefined;
			await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));

			await runCli([
				'snapshot',
				'save',
				'mine',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).not.toBe(0);
			// `--json` mode emits the failure envelope on stdout, not stderr.
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: { readonly summary: string };
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.error.summary).toMatch(/already running/i);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);
});
