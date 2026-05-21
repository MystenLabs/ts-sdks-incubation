// `logs` verb: per-event JSON records carry `kind: 'event'` so a
// consumer can distinguish them from the closing envelope (surfaces
// review §1: envelope-per-event invariant).

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { EngineEvent } from '../../../../src/substrate/events.ts';
import { runLogs } from '../../../../src/surfaces/cli/commands/logs.ts';
import type { CliIO } from '../../../../src/surfaces/cli/output.ts';

const makeIo = () => {
	const stdout: string[] = [];
	let exitCode: number | null = null;
	const io: CliIO = {
		writeStdout: (l) => Effect.sync(() => void stdout.push(l)),
		writeStderr: () => Effect.void,
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};
	return { io, stdout, getExitCode: () => exitCode };
};

const baseFlags = {
	outputMode: 'json' as const,
	app: undefined,
	stack: undefined,
	stateDir: undefined,
	configPath: undefined,
	network: undefined,
	renderer: undefined,
	dryRun: false,
	confirm: { assumeYes: false, forbidPrompt: false, stdinIsTty: true },
	schemaEmit: false,
	verbose: false,
	help: false,
	version: false,
	rest: ['my-plugin'] as ReadonlyArray<string>,
};

describe('logs', () => {
	it('emits event records with kind=event, distinct from closing envelope', async () => {
		const { io, stdout } = makeIo();
		// Pre-stage one event to be delivered; the subscriber fires it
		// before the test's "shutdown" Effect.void resolves.
		const event: Extract<EngineEvent, { tag: 'log.appended' }> = {
			tag: 'log.appended',
			pluginKey: 'my-plugin' as never,
			level: 'info',
			line: 'hello',
			at: Date.UTC(2026, 0, 1, 0, 0, 0),
		};
		await Effect.runPromise(
			runLogs(
				{
					subscriber: {
						subscribe: (handler) =>
							Effect.gen(function* () {
								yield* handler(event);
								return { unsubscribe: Effect.void };
							}),
					},
					shutdown: Effect.void,
				},
				{ flags: baseFlags, io },
			),
		);
		// stdout should contain at least one event record + closing envelope.
		expect(stdout.length).toBeGreaterThanOrEqual(2);
		const eventRecord = JSON.parse(stdout[0]!) as { kind?: string; data?: { line?: string } };
		expect(eventRecord.kind).toBe('event');
		expect(eventRecord.data?.line).toBe('hello');
		// Closing envelope has `ok: true` and NO `kind: 'event'`.
		const closing = JSON.parse(stdout[stdout.length - 1]!) as { kind?: string; ok?: boolean };
		expect(closing.kind).toBeUndefined();
		expect(closing.ok).toBe(true);
	});
});
