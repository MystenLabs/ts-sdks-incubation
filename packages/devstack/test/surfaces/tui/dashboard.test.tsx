import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { SubscribableState } from '../../../src/substrate/projection.ts';
import { Dashboard } from '../../../src/surfaces/tui/dashboard.tsx';

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
		phase: 'shutting-down',
	},
	rows: [
		{
			key: pluginKey('sui#0'),
			role: 'service',
			status: 'ready',
			phase: null,
			lastError: null,
			logTail: {
				lines: ['JSON-RPC listening on 0.0.0.0:9000', 'localnet ready'],
				level: 'info',
				truncated: false,
			},
			endpoints: [endpointKey('sui#0:rpc')],
			selectiveRestartHighlight: false,
		},
		{
			key: pluginKey('account/alice#1'),
			role: 'task',
			status: 'ready',
			phase: 'funded account 0xabc',
			lastError: null,
			logTail: { lines: ['address=0xabc'], level: 'info', truncated: false },
			endpoints: [],
			selectiveRestartHighlight: false,
		},
		{
			key: pluginKey('package/connect-four#2'),
			role: 'task',
			status: 'ready',
			phase: 'published package 0x123',
			lastError: null,
			logTail: { lines: ['packageId=0x123'], level: 'info', truncated: false },
			endpoints: [],
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
	accounts: [
		{
			key: 'account/alice',
			rowKey: pluginKey('account/alice#1'),
			name: 'alice',
			address: '0xabc',
			scheme: 'ed25519',
			source: 'real',
			funding: { status: 'unknown', balanceMist: null, requestedMist: null },
			walletVisible: false,
			updatedAt: AT,
		},
	],
	packages: [
		{
			key: 'package/connect-four',
			rowKey: pluginKey('package/connect-four#2'),
			name: 'connect-four',
			kind: 'local',
			packageId: '0x123',
			upgradeCapId: '0xcap',
			mvrPlaceholder: '@local/connect-four',
			sourcePath: 'move/connect_four',
			updatedAt: AT,
		},
	],
	errors: [],
	lastEvent: { seq: 3, at: AT },
	stackBuild: [],
});

const stateWithMultipleServiceUrls = (): SubscribableState => {
	const base = state();
	const endpointKeys = [
		endpointKey('sui#0:rpc'),
		endpointKey('sui#0:faucet'),
		endpointKey('sui#0:graphql'),
	];
	return {
		...base,
		rows: base.rows.map((row, index) =>
			index === 0
				? {
						...row,
						endpoints: endpointKeys,
					}
				: row,
		),
		endpoints: [
			{
				endpointKey: endpointKeys[0]!,
				name: 'rpc',
				url: 'http://127.0.0.1:51001',
				displayUrl: 'http://rpc.private-content.private-content.localhost:9000',
				wireProtocol: 'h2c',
				registeredAt: AT,
			},
			{
				endpointKey: endpointKeys[1]!,
				name: 'faucet',
				url: 'http://127.0.0.1:50001',
				displayUrl: 'http://faucet.private-content.private-content.localhost:9123',
				wireProtocol: 'http',
				registeredAt: AT,
			},
			{
				endpointKey: endpointKeys[2]!,
				name: 'graphql',
				url: 'http://127.0.0.1:51002',
				displayUrl: 'http://graphql.private-content.private-content.localhost:9125',
				wireProtocol: 'http',
				registeredAt: AT,
			},
		],
	};
};

const stateWithStructuredError = (): SubscribableState => {
	const base = state();
	const error = {
		at: AT,
		pluginKey: pluginKey('sui#0'),
		tag: 'BootError',
		summary: 'root service failed',
		chain: ['stderr: detailed failure that belongs in logs'],
		severity: 'error' as const,
	};
	return {
		...base,
		rows: base.rows.map((row) =>
			row.key === 'sui#0'
				? {
						...row,
						status: 'failed',
						lastError: error,
					}
				: row,
		),
		errors: [error],
	};
};

describe('Dashboard', () => {
	it('renders activity lines above grouped resource tables', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={state()}
				snapshotPromptValue={null}
				snapshotStatus={null}
				eventLog={[
					{
						id: '1',
						time: '20:11:33',
						scope: 'Stack',
						scopeColor: 'white',
						message: 'shutdown requested; waiting for graceful stop',
						level: 'warn',
						text: '20:11:33 shutdown requested; waiting for graceful stop',
					},
					{
						id: '2',
						time: '20:11:34',
						scope: 'Stack',
						scopeColor: 'white',
						message: 'shutdown hard-kill escalated by SIGINT (exit 130)',
						level: 'warn',
						text: '20:11:34 shutdown hard-kill escalated by SIGINT (exit 130)',
					},
				]}
			/>,
		);

		const frame = lastFrame() ?? '';
		expect(frame.indexOf('shutdown requested; waiting for graceful stop')).toBeLessThan(
			frame.indexOf('wallet/local'),
		);
		expect(frame).toContain('shutdown requested; waiting for graceful stop');
		expect(frame).toContain('shutdown hard-kill escalated by SIGINT (exit 130)');
		expect(frame).toContain('3/3 ready');
		expect(frame).toContain('1 urls');
		expect(frame).toContain('1 packages');
		expect(frame).toContain('Stack');
		expect(frame).toContain('Services');
		expect(frame).toContain('STATE');
		expect(frame).toContain('URLS');
		expect(frame).toContain('Accounts');
		expect(frame).toContain('Alice');
		expect(frame).toContain('0xabc');
		expect(frame).toContain('Packages');
		expect(frame).toContain('Connect four');
		expect(frame).toContain('0x123');
		expect(frame).toContain('@local/connect-four');
		expect(frame).not.toContain('0xcap');
		expect(frame.replace(/\s+/g, '')).toContain(
			'rpc:http://sui.wallet.localhost:9000->http://127.0.0.1:9000[h2c]',
		);
		expect(frame).not.toContain('address=0xabc');
		expect(frame).not.toContain('packageId=0x123');
		expect(frame).not.toContain('Open URLs');
		expect(frame).not.toContain('Selected -');
		expect(frame).not.toContain('[up/down]');

		unmount();
	});

	it('stacks multiple service URLs without joining them into one clipped cell', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={stateWithMultipleServiceUrls()}
				eventLog={[]}
				snapshotPromptValue={null}
				snapshotStatus={null}
			/>,
		);

		const frame = lastFrame() ?? '';
		const compact = frame.replace(/\s+/g, '');
		expect(compact).toContain('rpc:http://rpc.private-content.private-content.localhost:9000');
		expect(compact).toContain(
			'faucet:http://faucet.private-content.private-content.localhost:9123',
		);
		expect(compact).toContain(
			'graphql:http://graphql.private-content.private-content.localhost:9125',
		);
		expect(compact).toContain('http://127.0.0.1:51001[h2c]');
		expect(frame).not.toContain(' | faucet:');
		expect(frame).not.toContain('priva…');

		unmount();
	});

	it('keeps detailed error cascades out of the bottom dashboard', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={stateWithStructuredError()}
				eventLog={[]}
				snapshotPromptValue={null}
				snapshotStatus={null}
			/>,
		);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('BootError: root service failed');
		expect(frame).not.toContain('Errors');
		expect(frame).not.toContain('stderr: detailed failure that belongs in logs');

		unmount();
	});

	it('renders the interactive snapshot prompt when active', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={state()}
				eventLog={[]}
				snapshotPromptValue="before-change"
				snapshotStatus={null}
			/>,
		);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Snapshot name:');
		expect(frame).toContain('before-change');
		expect(frame).toContain('Enter save Esc cancel');

		unmount();
	});

	it('renders bottom snapshot progress with paused state', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={state()}
				eventLog={[]}
				snapshotPromptValue={null}
				snapshotStatus={{
					tag: 'running',
					phase: 'capturing-host-tree',
					name: 'before-change',
					pausedContainers: 2,
					totalContainers: 2,
					detail: 'archiving 1 host subtree',
					at: AT,
				}}
			/>,
		);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Snapshot:');
		expect(frame).toContain('before-change');
		expect(frame).toContain('capturing files');
		expect(frame).toContain('stack paused');
		expect(frame).toContain('2/2');
		expect(frame).toContain('archiving 1 host subtree');

		unmount();
	});
});
