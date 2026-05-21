import { Effect, Queue } from 'effect';
import { describe, expect, it } from 'vitest';

import type { EngineCommand } from '../../src/substrate/events.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from '../../src/cli/up-lifecycle.ts';

describe('resolveUpRendererMode', () => {
	it('defaults to TUI on a TTY', () => {
		expect(
			resolveUpRendererMode({
				cliRenderer: undefined,
				stackRenderer: undefined,
				stdoutIsTty: true,
			}),
		).toBe('ink');
	});

	it('defaults to plain off a TTY', () => {
		expect(
			resolveUpRendererMode({
				cliRenderer: undefined,
				stackRenderer: undefined,
				stdoutIsTty: false,
			}),
		).toBe('plain');
	});

	it('lets CLI renderer override stack options and TTY detection', () => {
		expect(
			resolveUpRendererMode({
				cliRenderer: 'plain',
				stackRenderer: 'tui',
				stdoutIsTty: true,
			}),
		).toBe('plain');
	});

	it('uses stack renderer options when no CLI override is present', () => {
		expect(
			resolveUpRendererMode({
				cliRenderer: undefined,
				stackRenderer: 'silent',
				stdoutIsTty: true,
			}),
		).toBe('silent');
	});
});

describe('makeQueueCommandPublisher', () => {
	it('routes TUI quit commands through the supervisor command queue', async () => {
		const commands = Effect.runSync(Queue.unbounded<EngineCommand>());
		const publish = makeQueueCommandPublisher(commands);

		publish({ tag: 'shutdown.requested' });

		await expect(Effect.runPromise(Queue.take(commands))).resolves.toEqual({
			tag: 'shutdown.requested',
		});
	});
});
