import { render } from 'ink-testing-library';
import { Effect, Queue, Stream, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { EngineCommand, EngineEvent } from '../../../src/substrate/events.ts';
import type { SubscribableState } from '../../../src/substrate/projection.ts';
import { App } from '../../../src/surfaces/tui/app.tsx';

const AT = Date.parse('2026-05-19T20:11:32.001Z');

const state = (): SubscribableState => ({
	identity: {
		app: 'wallet',
		stack: 'local',
		network: 'localnet',
	},
	cycle: {
		id: 7,
		startedAt: AT,
		phase: 'running',
	},
	rows: [
		{
			key: pluginKey('sui#0'),
			role: 'service',
			status: 'ready',
			phase: null,
			lastError: null,
			logTail: { lines: ['localnet ready'], level: 'info', truncated: false },
			endpoints: [endpointKey('sui#0:rpc')],
			selectiveRestartHighlight: false,
		},
	],
	endpoints: [
		{
			endpointKey: endpointKey('sui#0:rpc'),
			name: 'rpc',
			url: 'http://127.0.0.1:9000',
			displayUrl: 'http://sui.wallet.localhost:9000',
			wireProtocol: 'h2c',
			registeredAt: AT,
		},
	],
	accounts: [],
	packages: [],
	errors: [],
	lastEvent: { seq: 3, at: AT },
	stackBuild: [],
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (assertion: () => void, timeoutMs = 1000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await sleep(10);
		}
	}
	if (lastError !== undefined) throw lastError;
	throw new Error('timed out waiting for assertion');
};

describe('App snapshot flow', () => {
	it(
		'drives named snapshot capture through real Ink input and renders paused progress',
		async () => {
			const stateRef = Effect.runSync(SubscriptionRef.make(state()));
			const events = Effect.runSync(Queue.unbounded<EngineEvent>());
			const published: EngineCommand[] = [];
			const instance = render(
				<App
					stateRef={stateRef}
					events={Stream.fromQueue(events)}
					publish={(command) => {
						published.push(command);
					}}
				/>,
			);

			try {
				await waitFor(() => {
					expect(instance.lastFrame() ?? '').toContain('wallet/local');
				});

				instance.stdin.write('s');
				await waitFor(() => {
					const frame = instance.lastFrame() ?? '';
					expect(frame).toContain('Snapshot name:');
					expect(frame).toContain('<auto>');
				});

				instance.stdin.write('before-change');
				await waitFor(() => {
					expect(instance.lastFrame() ?? '').toContain('before-change');
				});

				instance.stdin.write('\r');
				await waitFor(() => {
					expect(published).toContainEqual({ tag: 'snapshot.capture', name: 'before-change' });
				});
				await waitFor(() => {
					expect(instance.lastFrame() ?? '').not.toContain('Snapshot name:');
				});

				await Effect.runPromise(
					Queue.offer(events, {
						tag: 'snapshot.captureStarted',
						name: 'before-change',
						at: AT + 1,
					}),
				);
				await waitFor(() => {
					const frame = instance.lastFrame() ?? '';
					expect(frame).toContain('Snapshot:');
					expect(frame).toContain('before-change');
					expect(frame).toContain('starting');
				}, 5_000);

				await Effect.runPromise(
					Queue.offer(events, {
						tag: 'snapshot.captureProgress',
						name: 'before-change',
						phase: 'capturing-host-tree',
						detail: 'archiving 1 host subtree',
						pausedContainers: 2,
						totalContainers: 2,
						at: AT + 2,
					}),
				);
				await waitFor(() => {
					const frame = instance.lastFrame() ?? '';
					expect(frame).toContain('capturing files');
					expect(frame).toContain('stack paused');
					expect(frame).toContain('2/2');
					expect(frame).toContain('archiving 1 host subtree');
				}, 5_000);

				instance.stdin.write('q');
				await waitFor(() => {
					expect(published).toContainEqual({ tag: 'shutdown.requested' });
				});
			} finally {
				instance.unmount();
				instance.cleanup();
			}
		},
		15_000,
	);
});
