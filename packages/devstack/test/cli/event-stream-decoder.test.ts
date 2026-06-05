import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('cli/main event-stream decoder', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('survives a malformed events.ndjson line and completes on a subsequent valid event', async () => {
		// A peer supervisor's atomic append may flush a partial / corrupt line
		// just as the CLI's tail loop polls. The completion fiber MUST keep
		// scanning and not die out with a decode failure.
		const stateRoot = makeTempRoot('cli-decoder-survives-state');
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
									readonly name?: string;
								};
								// Inject a truncated / corrupt NDJSON line BEFORE the valid
								// completion event. The CLI's tail must skip the corrupt row
								// instead of crashing.
								yield* Effect.sync(() => {
									appendFileSync(
										commandChannelPaths(stackRoot).eventsFile,
										'{"this":"is not a valid EventRecord shape"\n',
									);
								});
								if (command.snapshotId !== undefined) {
									yield* subscriber.publishEvent({
										tag: 'snapshot.captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
										at: Date.now(),
									});
								}
								yield* subscriber.publishReply(record.id, { kind: 'ack', detail: 'captured' });
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
				'after-corruption',
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
			expect(envelope.data.name).toBe('after-corruption');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);
});
