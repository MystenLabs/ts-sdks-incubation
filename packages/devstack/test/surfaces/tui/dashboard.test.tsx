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
			kind: 'leaf-long-running',
			status: 'ready',
			phase: null,
			lastError: null,
			logTail: {
				lines: ['JSON-RPC listening on 0.0.0.0:9000', 'localnet ready'],
				level: 'info',
				truncated: false,
			},
			endpoints: [endpointKey('sui#0:rpc')],
			compositeChildren: null,
			selectiveRestartHighlight: false,
			narrationByContributor: null,
			rebootCost: null,
			displayHint: undefined,
		},
		{
			key: pluginKey('account/alice#1'),
			kind: 'leaf-one-shot',
			status: 'ready',
			phase: 'funded account 0xabc',
			lastError: null,
			logTail: { lines: ['address=0xabc'], level: 'info', truncated: false },
			endpoints: [],
			compositeChildren: null,
			selectiveRestartHighlight: false,
			narrationByContributor: null,
			rebootCost: null,
			displayHint: undefined,
		},
		{
			key: pluginKey('package/connect-four#2'),
			kind: 'leaf-one-shot',
			status: 'ready',
			phase: 'published package 0x123',
			lastError: null,
			logTail: { lines: ['packageId=0x123'], level: 'info', truncated: false },
			endpoints: [],
			compositeChildren: null,
			selectiveRestartHighlight: false,
			narrationByContributor: null,
			rebootCost: null,
			displayHint: undefined,
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
			upgradeCapId: null,
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

describe('Dashboard', () => {
	it('renders activity lines above grouped resource tables', () => {
		const { lastFrame, unmount } = render(
			<Dashboard
				state={state()}
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
		expect(frame).toContain('ed25519');
		expect(frame).toContain('real');
		expect(frame).toContain('funding unknown');
		expect(frame).toContain('Packages');
		expect(frame).toContain('Connect four');
		expect(frame).toContain('0x123');
		expect(frame).toContain('@local/connect-four');
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
			<Dashboard state={stateWithMultipleServiceUrls()} eventLog={[]} />,
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
});
