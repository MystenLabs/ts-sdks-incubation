// Display-derivation tests.
//
// These verify the load-bearing invariants:
//   1. EVERY visible cell is computed from `row.role` + `row.status`
//      + `row.phase` + `row.lastError` — NOT from any pre-baked
//      `title`/`primary`/`extras` field.
//   2. Status / role tables are exhaustive (all enum members render).
//   3. Truncation caps fire on overly-long phase / error inputs.
//
// The tests do NOT boot any engine; they call pure functions with
// fabricated `Row` values. This is the "test the renderer against a
// fake projection" pattern from distilled/21-tui § Learnings.

import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { LifecycleStatus, PluginRole } from '../../../src/substrate/lifecycle.ts';
import type {
	AccountProjection,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
} from '../../../src/substrate/projection.ts';
import {
	accountLine,
	accountCells,
	dashboardSummaryLine,
	deriveDisplayCells,
	deriveDashboardSummary,
	endpointsForRow,
	endpointsSummaryForRow,
	endpointLine,
	errorSummaryFor,
	groupRows,
	labelForRow,
	narrationFor,
	ownerForRow,
	packageCells,
	packageLine,
	roleGlyph,
	roleLabel,
	roleLabelColor,
	sectionForRow,
	statusColor,
	statusGlyph,
	statusLabel,
	type RowSection,
	visibleEndpointsForRow,
} from '../../../src/surfaces/tui/display-derivation.ts';

const fakeRow = (overrides: Partial<Row> = {}): Row => ({
	key: pluginKey('devstack:sui'),
	role: 'service',
	status: 'ready',
	phase: null,
	lastError: null,
	logTail: { lines: [], level: 'info', truncated: false },
	endpoints: [],
	selectiveRestartHighlight: false,
	...overrides,
});

describe('display-derivation', () => {
	describe('statusGlyph / statusColor', () => {
		const allStatuses: ReadonlyArray<LifecycleStatus> = [
			'pending',
			'acquiring',
			'ready',
			'failed',
			'stopping',
			'stopped',
			'done',
		];
		it('returns a non-empty glyph for every status', () => {
			for (const s of allStatuses) {
				expect(statusGlyph(s).length).toBeGreaterThan(0);
				expect(statusGlyph(s)).not.toBe('?');
			}
		});
		it('returns a color token for every status', () => {
			for (const s of allStatuses) {
				expect(statusColor(s).length).toBeGreaterThan(0);
			}
		});
		it('returns operator-facing labels for every status', () => {
			const expected: Record<LifecycleStatus, string> = {
				pending: 'pending',
				acquiring: 'starting',
				ready: 'ready',
				failed: 'failed',
				stopping: 'stopping',
				stopped: 'stopped',
				done: 'done',
			};
			for (const s of allStatuses) {
				expect(statusLabel(s)).toBe(expected[s]);
			}
		});
	});

	describe('roleGlyph / roleLabel / roleLabelColor', () => {
		const allRoles: ReadonlyArray<PluginRole> = ['service', 'task'];
		it('returns a non-empty glyph + label for every role', () => {
			for (const role of allRoles) {
				expect(roleGlyph(role).length).toBeGreaterThan(0);
				expect(roleGlyph(role)).not.toBe('?');
				expect(roleLabel(role).length).toBeGreaterThan(0);
				expect(roleLabel(role)).not.toBe('unknown');
				expect(roleLabelColor(role)).not.toBe(undefined);
			}
		});
	});

	describe('labelForRow', () => {
		it('strips the devstack: prefix', () => {
			expect(labelForRow('devstack:sui')).toBe('Sui');
		});
		it('strips the app: prefix', () => {
			expect(labelForRow('app:wallet')).toBe('Wallet');
		});
		it('removes internal prefixes and counters', () => {
			expect(labelForRow('account/alice#0')).toBe('Alice');
			expect(labelForRow('seal/service/0')).toBe('Service');
		});
	});

	describe('ownerForRow / sectionForRow', () => {
		it('derives plugin owner chips from row keys', () => {
			expect(ownerForRow('account/alice#0')).toBe('Account');
			expect(ownerForRow('sui.localnet')).toBe('Sui');
		});
		it('groups long-running and endpoint rows as services unless the key names a package', () => {
			expect(sectionForRow(fakeRow({ role: 'service' }))).toBe('service');
			expect(
				sectionForRow(
					fakeRow({
						key: pluginKey('package/connect-four#0'),
						role: 'task',
						endpoints: [endpointKey('package/connect-four#0:docs')],
					}),
				),
			).toBe('package');
			expect(
				sectionForRow(
					fakeRow({
						key: pluginKey('app/frontend#0'),
						role: 'task',
						endpoints: [endpointKey('app/frontend#0:http')],
					}),
				),
			).toBe('service');
		});
		it('groups one-shot rows by friendly domain', () => {
			expect(
				sectionForRow(fakeRow({ key: pluginKey('package/connect-four#0'), role: 'task' })),
			).toBe('package');
			expect(sectionForRow(fakeRow({ key: pluginKey('account/alice#0'), role: 'task' }))).toBe(
				'account',
			);
			expect(sectionForRow(fakeRow({ key: pluginKey('action/mint#0'), role: 'task' }))).toBe(
				'action',
			);
			expect(sectionForRow(fakeRow({ key: pluginKey('app/frontend#0'), role: 'task' }))).toBe(
				'app',
			);
		});
		it('pins the section for every built-in plugin family', () => {
			const cases: ReadonlyArray<readonly [string, Row['role'], RowSection]> = [
				['sui#0', 'service', 'service'],
				['wallet#0', 'service', 'service'],
				['walrus:walrus', 'service', 'service'],
				['seal:seal', 'service', 'service'],
				['deepbook:deepbook', 'service', 'service'],
				['postgres#0', 'service', 'service'],
				['faucet#0', 'service', 'service'],
				['host-service/web', 'service', 'service'],
				['package:vault', 'task', 'package'],
				['account/alice', 'task', 'account'],
				['action:mint', 'task', 'action'],
				['coin:wal', 'task', 'action'],
				['app/frontend', 'task', 'app'],
			];
			for (const [key, role, section] of cases) {
				expect(sectionForRow(fakeRow({ key: pluginKey(key), role })), key).toBe(section);
			}
		});
	});

	describe('narrationFor', () => {
		it('returns empty for null phase on non-acquiring statuses', () => {
			expect(narrationFor(null, 'ready')).toBe('');
			expect(narrationFor(null, 'stopped')).toBe('');
		});
		it('returns "starting…" for null phase on acquiring', () => {
			expect(narrationFor(null, 'acquiring')).toBe('starting…');
		});
		it('truncates long narrations', () => {
			const long = 'x'.repeat(200);
			const out = narrationFor(long, 'acquiring');
			expect(out.length).toBeLessThanOrEqual(80);
			expect(out.endsWith('…')).toBe(true);
		});
		it('preserves short narrations verbatim', () => {
			expect(narrationFor('waiting for chain', 'acquiring')).toBe('waiting for chain');
		});
	});

	describe('errorSummaryFor', () => {
		const fakeErr = (summary: string): StructuredError => ({
			at: 0,
			pluginKey: null,
			tag: 'BootError',
			summary,
			chain: [],
			severity: 'error',
		});
		it('returns empty for null', () => {
			expect(errorSummaryFor(null)).toBe('');
		});
		it('renders tag + summary', () => {
			expect(errorSummaryFor(fakeErr('docker exited 1'))).toBe('BootError: docker exited 1');
		});
		it('truncates over 120 chars', () => {
			const long = 'x'.repeat(300);
			const out = errorSummaryFor(fakeErr(long));
			expect(out.length).toBeLessThanOrEqual(120);
			expect(out.endsWith('…')).toBe(true);
		});
	});

	describe('endpointLine', () => {
		it('prefers displayUrl over url', () => {
			expect(
				endpointLine({
					endpointKey: endpointKey('e1'),
					name: 'gql',
					url: 'http://localhost:9000',
					displayUrl: 'https://devstack.local/gql',
					wireProtocol: 'http',
					registeredAt: 0,
				}),
			).toBe('gql: https://devstack.local/gql -> http://localhost:9000');
		});
		it('falls back to url when displayUrl is null', () => {
			expect(
				endpointLine({
					endpointKey: endpointKey('e2'),
					name: 'rpc',
					url: 'http://localhost:9001',
					displayUrl: null,
					wireProtocol: 'http',
					registeredAt: 0,
				}),
			).toBe('rpc: http://localhost:9001');
		});
		it('marks non-http wire protocols without hiding the service URL', () => {
			expect(
				endpointLine({
					endpointKey: endpointKey('e3'),
					name: 'grpc',
					url: 'http://127.0.0.1:9184',
					displayUrl: 'http://sui-rpc.wallet.localhost:9184',
					wireProtocol: 'h2c',
					registeredAt: 0,
				}),
			).toBe('grpc: http://sui-rpc.wallet.localhost:9184 -> http://127.0.0.1:9184 [h2c]');
		});
	});

	describe('accountLine', () => {
		it('renders account facts from the top-level account projection', () => {
			const account: AccountProjection = {
				key: 'account/alice',
				rowKey: pluginKey('account/alice#1'),
				name: 'alice',
				address: '0xabc',
				scheme: 'ed25519',
				source: 'real',
				funding: { status: 'unknown', balanceMist: null, requestedMist: null },
				walletVisible: false,
				updatedAt: 0,
			};
			expect(accountLine(account)).toBe('Alice  0xabc  ed25519  real  funding unknown');
			expect(accountCells(account)).toEqual({
				name: 'Alice',
				address: '0xabc',
				scheme: 'ed25519',
				source: 'real',
				funding: 'funding unknown',
			});
		});

		it('renders funded account funding entries', () => {
			expect(
				accountLine({
					key: 'account/alice',
					rowKey: pluginKey('account/alice#1'),
					name: 'alice',
					address: '0xabc',
					scheme: 'ed25519',
					source: 'real',
					funding: {
						status: 'funded',
						balanceMist: null,
						requestedMist: '1000000000',
						entries: [
							{
								coin: 'SUI',
								fullCoinType: '0x2::sui::SUI',
								amount: '1000000000',
								status: 'funded',
							},
							{
								coin: 'DEEP',
								fullCoinType: '0xdeep::deep::DEEP',
								amount: '15000000',
								status: 'funded',
							},
						],
					},
					walletVisible: false,
					updatedAt: 0,
				}),
			).toBe('Alice  0xabc  ed25519  real  funded SUI:1000000000, DEEP:15000000');
		});

		it('keeps pending accounts visible before address resolution', () => {
			expect(
				accountLine({
					key: 'account/bob',
					rowKey: pluginKey('account/bob#2'),
					name: 'bob',
					address: null,
					scheme: null,
					source: null,
					funding: { status: 'pending', balanceMist: null, requestedMist: null },
					walletVisible: false,
					updatedAt: 0,
				}),
			).toBe('Bob  <pending>  scheme pending  source pending  funding pending');
		});
	});

	describe('packageLine', () => {
		it('renders package facts from the top-level package projection', () => {
			const pkg: PackageProjection = {
				key: 'package/vault',
				rowKey: pluginKey('package/vault#1'),
				name: 'vault',
				kind: 'local',
				packageId: '0x123',
				upgradeCapId: '0xcap',
				mvrPlaceholder: '@local/vault',
				sourcePath: 'move/vault',
				updatedAt: 0,
			};
			expect(packageLine(pkg)).toBe('Vault  0x123  @local/vault  local  upgrade 0xcap');
			expect(packageCells(pkg)).toEqual({
				name: 'Vault',
				packageId: '0x123',
				mvr: '@local/vault',
				kind: 'local',
				detail: 'local; upgrade 0xcap',
			});
		});
	});

	describe('row endpoints and grouping', () => {
		const endpoint = {
			endpointKey: endpointKey('sui:rpc'),
			name: 'rpc',
			url: 'http://localhost:9000',
			displayUrl: null,
			wireProtocol: 'http',
			registeredAt: 0,
		};

		it('selects endpoints owned by a row', () => {
			const row = fakeRow({ key: pluginKey('sui'), endpoints: [endpoint.endpointKey] });
			expect(endpointsForRow(row, [endpoint])).toEqual([endpoint]);
		});

		it('summarizes row endpoints inline for table rendering', () => {
			const walletEndpoint = {
				endpointKey: endpointKey('wallet#0:wallet-app'),
				name: 'wallet-app',
				url: 'http://wallet.demo.localhost:5175',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			};
			const row = fakeRow({ key: pluginKey('wallet#0'), role: 'service' });
			expect(endpointsSummaryForRow(row, [walletEndpoint])).toBe(
				'wallet-app: http://wallet.demo.localhost:5175',
			);
		});

		it('prefers routed endpoints over raw operational loopback fallbacks', () => {
			const row = fakeRow({ key: pluginKey('wallet#0'), role: 'service' });
			const operational = {
				endpointKey: endpointKey('wallet#0:url'),
				name: 'http',
				url: 'http://127.0.0.1:39200',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			};
			const routed = {
				endpointKey: endpointKey('wallet#0:wallet-app'),
				name: 'wallet-app',
				url: 'http://api.wallet.arena.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			};
			expect(visibleEndpointsForRow(row, [operational, routed])).toEqual([routed]);
			expect(endpointsSummaryForRow(row, [operational, routed])).toBe(
				'wallet-app: http://api.wallet.arena.localhost:6173',
			);
		});

		it('groups rows in operator scan order', () => {
			const sections = groupRows([
				fakeRow({ key: pluginKey('action/mint#0'), role: 'task' }),
				fakeRow({ key: pluginKey('account/alice#0'), role: 'task' }),
				fakeRow({ key: pluginKey('sui'), role: 'service' }),
			]);
			expect(sections.map((section) => section.key)).toEqual(['service', 'account', 'action']);
		});
	});

	describe('dashboard summary', () => {
		it('summarizes central projection slices for the header panel', () => {
			const rawEndpoint: Endpoint = {
				endpointKey: endpointKey('wallet#0:url'),
				name: 'http',
				url: 'http://127.0.0.1:39200',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			};
			const routedEndpoint: Endpoint = {
				endpointKey: endpointKey('wallet#0:wallet-app'),
				name: 'wallet-app',
				url: 'http://api.arena.arena.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			};
			const account: AccountProjection = {
				key: 'account/alice',
				rowKey: pluginKey('account/alice#1'),
				name: 'alice',
				address: '0xabc',
				scheme: 'ed25519',
				source: 'real',
				funding: {
					status: 'funded',
					balanceMist: null,
					requestedMist: '1000000000',
					entries: [
						{
							coin: 'SUI',
							fullCoinType: '0x2::sui::SUI',
							amount: '1000000000',
							status: 'funded',
						},
					],
				},
				walletVisible: true,
				updatedAt: 0,
			};
			const state = {
				rows: [
					fakeRow({ key: pluginKey('sui'), status: 'ready' }),
					fakeRow({ key: pluginKey('wallet#0'), status: 'acquiring' }),
					fakeRow({ key: pluginKey('action/open#0'), status: 'pending' }),
				],
				endpoints: [rawEndpoint, routedEndpoint],
				accounts: [account],
				packages: [],
				errors: [],
			};
			const summary = deriveDashboardSummary(state);
			expect(summary).toMatchObject({
				totalRows: 3,
				readyRows: 1,
				activeRows: 1,
				waitingRows: 1,
				endpointCount: 1,
				accountCount: 1,
				packageCount: 0,
				health: 'active',
			});
			expect(dashboardSummaryLine(summary)).toBe(
				'1/3 ready  1 active  1 waiting  1 urls  1 accounts  no errors',
			);
		});
	});

	describe('deriveDisplayCells', () => {
		it('produces every cell from row.role/status/phase/lastError', () => {
			const row = fakeRow({
				role: 'service',
				status: 'acquiring',
				phase: 'pulling image',
			});
			const cells = deriveDisplayCells(row);
			expect(cells.statusGlyph).toBe(statusGlyph('acquiring'));
			expect(cells.statusColor).toBe(statusColor('acquiring'));
			expect(cells.statusLabel).toBe('starting');
			expect(cells.roleGlyph).toBe(roleGlyph('service'));
			expect(cells.roleLabel).toBe('service');
			expect(cells.label).toBe('Sui');
			expect(cells.narration).toBe('pulling image');
			expect(cells.errorSummary).toBe('');
			expect(cells.section).toBe('service');
			expect(cells.owner).toBe('Sui');
		});
		it('renders error summary on failed row', () => {
			const row = fakeRow({
				status: 'failed',
				lastError: {
					at: 0,
					pluginKey: null,
					tag: 'BootError',
					summary: 'docker daemon unreachable',
					chain: [],
					severity: 'error',
				},
			});
			const cells = deriveDisplayCells(row);
			expect(cells.errorSummary).toContain('BootError');
			expect(cells.errorSummary).toContain('docker daemon unreachable');
		});
	});
});
