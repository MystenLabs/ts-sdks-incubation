// DeepBook plugin view. Header bar (Restart + "Logs & events"), KPIs, a pools
// table backed by on-chain pool-object reads, a Pyth-feeds card, a read-only
// market-maker card, and an addresses card.
//
// Data sources & honesty:
//   - Backend `fetchDeepbookInfo(endpoint)` is the source of truth for the
//     deployment: registry/admin-cap/package/treasury ids, the pool id+pair
//     list, the indexer/server URLs, and the live `marketMakerRunning` flag.
//   - Per-pool `tick / lot / min` are read ON-CHAIN from each pool object via
//     `useObject(chain, poolId)` — DeepBook's `Pool` Move struct carries
//     `tick_size / lot_size / min_size` in its JSON fields.
//   - Mid price, order-book depth, per-pool trend, 24h volume, and trade counts
//     require the DeepBook *indexer* (an off-chain service). When no indexer URL
//     is published we do NOT fabricate them: price/depth/trend render an honest
//     "indexer unavailable" empty state and volume/trades render "—".
//   - The market-maker card REFLECTS `marketMakerRunning`; there is no
//     control-plane mutation to start/stop it or set a spread, so the toggle and
//     the spread slider are read-only/disabled with an inline note. "Seed
//     liquidity" is likewise disabled (no browser-safe mutation exists).

import { type ReactNode } from 'react';
import { restartPlugin } from '../../lib/api.ts';
import type { DeepbookInfo } from '../../lib/api.ts';
import { useDeepbookInfo, useObject } from '../../lib/useChain.ts';
import { groupDigits, truncateMiddle } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { useToast } from '../../lib/toast.tsx';
import {
	Badge,
	CopyChip,
	EmptyState,
	Icon,
	Kpi,
	Panel,
	SectionHead,
	Slider,
	Switch,
	Tooltip,
} from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

const EM_DASH = '—';

/** A key/value row matching the design's `PField` (label left, value right). */
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
	<div
		className="row between"
		style={{ padding: '9px 0', borderBottom: '1px solid var(--line-faint)', gap: 12 }}
	>
		<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>{label}</span>
		<span style={{ textAlign: 'right', minWidth: 0 }}>{children}</span>
	</div>
);

/** Short coin-symbol from a fully-qualified coin type (`…::usdc::USDC` → `USDC`). */
const coinSymbol = (coinType: string): string => {
	const tail = coinType.split('::').pop() ?? coinType;
	return tail || coinType;
};

/** Human pair label for a pool, preferring its name, falling back to coin types. */
const pairLabel = (pool: DeepbookInfo['pools'][number]): string => {
	if (pool.name) return pool.name;
	const base = coinSymbol(pool.baseCoinType);
	const quote = coinSymbol(pool.quoteCoinType);
	return base && quote ? `${base} / ${quote}` : pool.poolId;
};

interface PoolRow {
	readonly poolId: string;
	readonly pair: string;
}

/** Pull a u64-ish numeric field out of a pool object's parsed Move fields. */
const numericField = (
	fields: Record<string, unknown> | null,
	...names: ReadonlyArray<string>
): string | null => {
	if (!fields) return null;
	for (const name of names) {
		const raw = fields[name];
		if (typeof raw === 'string' || typeof raw === 'number') return groupDigits(String(raw));
		if (typeof raw === 'bigint') return groupDigits(raw.toString());
	}
	return null;
};

/** One pools-table row. Reads the live pool object for tick/lot/min. */
const PoolTableRow = ({
	pool,
	chain,
}: {
	readonly pool: PoolRow;
	readonly chain: PluginViewProps['chain'];
}) => {
	const obj = useObject(chain, pool.poolId);
	const fields = obj.data?.fields ?? null;
	const tick = numericField(fields, 'tick_size', 'tickSize');
	const lot = numericField(fields, 'lot_size', 'lotSize');
	const min = numericField(fields, 'min_size', 'minSize');
	const dim = { color: 'var(--tx-lo)', fontSize: 12 } as const;
	return (
		<tr>
			<td>
				<span style={{ fontWeight: 550 }}>{pool.pair}</span>
			</td>
			{/* Price/24h/trend/depth/trades need the DeepBook indexer — honest dashes. */}
			<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
				{EM_DASH}
			</td>
			<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
				{EM_DASH}
			</td>
			<td className="mono tnum" style={dim}>
				{obj.isLoading ? '…' : (tick ?? EM_DASH)}
			</td>
			<td className="mono tnum" style={dim}>
				{obj.isLoading ? '…' : (lot ?? EM_DASH)}
			</td>
			<td className="mono tnum" style={dim}>
				{obj.isLoading ? '…' : (min ?? EM_DASH)}
			</td>
			<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
				{EM_DASH}
			</td>
			<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
				{EM_DASH}
			</td>
			<td>
				<CopyChip text={pool.poolId} display={truncateMiddle(pool.poolId, 5, 3)} />
			</td>
		</tr>
	);
};

export const DeepBookView = ({ row, endpoint, chain }: PluginViewProps) => {
	const { success, info } = useToast();
	const network = chain.network;

	// Load the DeepBook deployment(s) from the control plane; re-keyed when the
	// connected stack (endpoint/network) changes.
	const deepbookQuery = useDeepbookInfo(endpoint, network);
	const deployments: ReadonlyArray<DeepbookInfo> = deepbookQuery.data ?? [];
	const loading = deepbookQuery.isLoading;

	// One DeepBook deployment backs a plugin page; if several resolve, the row's
	// pluginKey picks the matching one, else the first.
	const info0 =
		(row ? deployments.find((d) => d.pluginKey === row.key) : undefined) ?? deployments[0] ?? null;

	const header = (children: ReactNode) => (
		<PluginScaffold
			label="DeepBook"
			icon="box"
			row={row}
			token="blue"
			subtitle="CLOB · liquidity"
			phase={row?.phase ?? info0?.pluginKey ?? 'deepbook'}
			actions={
				<>
					<button
						className="btn btn-sm"
						onClick={() => {
							const key = info0?.pluginKey ?? row?.key;
							if (!key) return;
							void restartPlugin(endpoint, key)
								.then((r) =>
									r.ok
										? success(r.message ?? 'Restart requested')
										: info(r.message ?? 'Restart failed'),
								)
								.catch((e: unknown) => info(e instanceof Error ? e.message : String(e)));
						}}
					>
						<Icon name="refresh" size={13} /> Restart
					</button>
					{row && (
						<button className="btn btn-sm btn-ghost" onClick={() => navigate('activity')}>
							Logs &amp; events
						</button>
					)}
				</>
			}
		>
			{children}
		</PluginScaffold>
	);

	if (loading && deployments.length === 0) {
		return header(
			<Panel pad>
				<EmptyState icon="box" title="Loading DeepBook…" />
			</Panel>,
		);
	}

	if (!info0) {
		return header(
			<Panel pad>
				<EmptyState
					icon="box"
					title="No DeepBook deployment"
					hint="The control plane reports no resolved DeepBook plugin for this stack."
				/>
			</Panel>,
		);
	}

	const pools: ReadonlyArray<PoolRow> = info0.pools.map((p) => ({
		poolId: p.poolId,
		pair: pairLabel(p),
	}));
	const hasIndexer = Boolean(info0.indexerUrl);
	const mmRunning = info0.marketMakerRunning;

	return header(
		<>
			{/* KPIs. Volume/trends need the indexer; shown as unavailable when absent. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
					gap: 14,
				}}
			>
				<Kpi label="Pools" value={pools.length} sub="active" token="blue" icon="box" />
				<Kpi
					label="24h volume"
					value={EM_DASH}
					sub={hasIndexer ? 'indexer' : 'no indexer'}
					icon="activity"
				/>
				<Kpi
					label="DEEP treasury"
					value={info0.deepTreasuryId ? 'present' : EM_DASH}
					sub={info0.deepTreasuryId ? truncateMiddle(info0.deepTreasuryId, 5, 3) : 'none'}
					token="cyan"
					icon="coins"
				/>
				<Kpi
					label="Market maker"
					value={mmRunning ? 'Running' : 'Stopped'}
					token={mmRunning ? 'green' : 'white'}
					icon="zap"
				/>
			</div>

			{/* Price + order-book depth need the indexer; render honest empties. */}
			<div
				style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 18, alignItems: 'start' }}
			>
				<Panel pad>
					<SectionHead title="Price" />
					<EmptyState
						icon="activity"
						title="Price feed unavailable"
						hint="Mid-price history comes from the DeepBook indexer, which isn't reachable from the browser for this stack."
					/>
				</Panel>
				<Panel pad>
					<SectionHead title="Order book depth" />
					<EmptyState
						icon="layers"
						title="Depth unavailable"
						hint="Order-book depth is served by the DeepBook indexer; not available here."
					/>
				</Panel>
			</div>

			{/* Pools — pair + on-chain tick/lot/min + pool id. */}
			<Panel
				header={
					<SectionHead
						title="Pools"
						count={pools.length}
						right={
							<Tooltip label="No browser-safe seed mutation is exposed by the control plane.">
								<button className="btn btn-sm" disabled>
									<Icon name="drop" size={13} /> Seed liquidity
								</button>
							</Tooltip>
						}
					/>
				}
			>
				{pools.length === 0 ? (
					<EmptyState icon="box" title="No pools" hint="This deployment registered no pools." />
				) : (
					<table className="tbl">
						<thead>
							<tr>
								<th>Pair</th>
								<th>Price</th>
								<th>24h</th>
								<th>Tick</th>
								<th>Lot</th>
								<th>Min</th>
								<th>Depth</th>
								<th>Trades</th>
								<th>Pool ID</th>
							</tr>
						</thead>
						<tbody>
							{pools.map((p) => (
								<PoolTableRow key={p.poolId} pool={p} chain={chain} />
							))}
						</tbody>
					</table>
				)}
			</Panel>

			<div
				style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 18, alignItems: 'start' }}
			>
				{/* Pyth feeds — not surfaced by the control plane for this deployment. */}
				<Panel header={<SectionHead title="Pyth price feeds" />}>
					<EmptyState
						icon="activity"
						title="No Pyth feeds reported"
						hint="Pyth lives inside DeepBook by default; the control plane exposes no feed snapshot for the dashboard, so none are shown rather than fabricated."
					/>
				</Panel>

				<div className="col" style={{ gap: 18 }}>
					{/* Market maker — read-only reflection of the backend MM flag. */}
					<Panel pad>
						<SectionHead title="Market maker" />
						<Field label="Status">
							<span className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
								<span
									style={{ fontSize: 12.5, color: mmRunning ? 'var(--c-green)' : 'var(--tx-lo)' }}
								>
									{mmRunning ? 'running' : 'stopped'}
								</span>
								<Tooltip label="Read-only — no control-plane mutation to start/stop the market maker.">
									<span style={{ opacity: 0.6, pointerEvents: 'none' }}>
										<Switch checked={mmRunning} />
									</span>
								</Tooltip>
							</span>
						</Field>
						<Field label="Spread">
							<Tooltip label="Read-only — the spread isn't exposed or mutable via the control plane.">
								<span style={{ opacity: 0.6 }}>
									<Slider value={0} min={0} max={50} suffix="bps" width={120} />
								</span>
							</Tooltip>
						</Field>
						<div style={{ fontSize: 11.5, color: 'var(--tx-dim)', paddingTop: 8 }}>
							Reflects the live deployment state. Controls are disabled until the control plane
							exposes a market-maker mutation.
						</div>
					</Panel>

					{/* Addresses — all real ids from the backend deployment record. */}
					<Panel pad>
						<SectionHead title="Addresses" />
						<Field label="Package">
							{info0.packageId ? (
								<CopyChip text={info0.packageId} display={truncateMiddle(info0.packageId)} />
							) : (
								<span style={{ color: 'var(--tx-dim)' }}>{EM_DASH}</span>
							)}
						</Field>
						<Field label="Registry">
							{info0.registryId ? (
								<CopyChip text={info0.registryId} display={truncateMiddle(info0.registryId)} />
							) : (
								<span style={{ color: 'var(--tx-dim)' }}>{EM_DASH}</span>
							)}
						</Field>
						<Field label="Admin cap">
							{info0.adminCapId ? (
								<CopyChip text={info0.adminCapId} display={truncateMiddle(info0.adminCapId)} />
							) : (
								<span style={{ color: 'var(--tx-dim)' }}>{EM_DASH}</span>
							)}
						</Field>
						<Field label="Mode">
							<Badge style={{ height: 19, fontSize: 11 }}>{info0.mode}</Badge>
						</Field>
					</Panel>
				</div>
			</div>
		</>,
	);
};
