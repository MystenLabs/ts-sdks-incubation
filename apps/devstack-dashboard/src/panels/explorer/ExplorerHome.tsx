// Explorer home — the suiscan-style landing view. A KPI row (epoch / checkpoint
// / total tx / TPS / ref gas) backed by `useChainHead` + `useEpochInfo` +
// `useReferenceGasPrice`. Total tx is the head checkpoint's running
// `total_network_transactions`; TPS is a REAL Δ(totalTransactions)/Δt rate
// derived across head ticks (falling back to the honest checkpoint rate when the
// transaction total isn't yet available). Then two columns: the live
// "Latest transactions" table
// (`useLatestTransactions`, which walks checkpoints back from the head) and a
// "Packages" list sourced from `projection.packages`. Packages published by this
// stack (`kind === 'local'`) get a blue dot + "published here" badge.
//
// We intentionally do NOT fabricate historical series: the design's tx/day and
// active-accounts charts are omitted because no real history source exists in
// the browser-direct read path. Everything rendered is a live chain read.
//
// This module also exports the shared `DetailSkeleton` and `isOurs` helpers used
// by the sibling detail views (kept here to stay within the panel's file set).

import { timeAgo, truncateMiddle } from '../../lib/format.ts';
import { gotoPackage, gotoTx } from '../../lib/router.ts';
import type { PackageProjection, Projection } from '../../lib/types.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import {
	useChainHead,
	useChainRate,
	useEpochInfo,
	useLatestTransactions,
	useReferenceGasPrice,
} from '../../lib/useChain.ts';
import type { TxSummary } from '../../lib/explorerTypes.ts';
import {
	Banner,
	type Column,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	Kpi,
	Panel,
	SectionHead,
	Skeleton,
	SkeletonRows,
} from '../../ui/index.ts';

/** True when an id matches a package published by this stack (`kind: 'local'`). */
export const isOurs = (projection: Projection, id: string): boolean =>
	projection.packages.some((p) => p.kind === 'local' && p.packageId === id);

/** The matching package projection for an id, if this stack published it. */
export const ourPackage = (projection: Projection, id: string): PackageProjection | undefined =>
	projection.packages.find((p) => p.packageId === id);

/** Shared detail-loading placeholder: a header card stub + a table stub. */
export const DetailSkeleton = () => (
	<div className="col" style={{ gap: 18 }}>
		<Panel pad className="col" style={{ gap: 12 }}>
			<Skeleton w={180} h={18} />
			<Skeleton w="60%" />
			<Skeleton w="40%" />
		</Panel>
		<Panel style={{ overflow: 'hidden' }}>
			<SkeletonRows rows={5} cols={3} />
		</Panel>
	</div>
);

interface ExplorerHomeProps {
	readonly chain: ChainSource;
	readonly projection: Projection;
	readonly unreachable: boolean;
}

const epochProgress = (startMs: number, durationMs: number | null): number | null => {
	if (!durationMs || durationMs <= 0) return null;
	const pct = ((Date.now() - startMs) / durationMs) * 100;
	return Math.max(0, Math.min(100, Math.round(pct)));
};

export const ExplorerHome = ({ chain, projection, unreachable }: ExplorerHomeProps) => {
	const head = useChainHead(chain);
	const epoch = useEpochInfo(chain);
	const gas = useReferenceGasPrice(chain);
	const txs = useLatestTransactions(chain, 20);

	const packages = projection.packages;

	const headData = head.data;
	const epochData = epoch.data;
	const progress = epochData
		? epochProgress(epochData.epochStartMs, epochData.epochDurationMs)
		: null;

	const { rate, isTps } = useChainRate(
		chain.network,
		headData?.checkpoint ?? null,
		headData?.totalTransactions ?? null,
		headData?.timestampMs ?? null,
	);

	const dash = (v: number | undefined): string => (v == null ? '—' : String(v));

	const columns: ReadonlyArray<Column<TxSummary>> = [
		{
			key: 'digest',
			header: 'Digest',
			render: (tx) => (
				<span className="mono" style={{ color: 'var(--c-cyan)', fontSize: 12.5 }}>
					{truncateMiddle(tx.digest, 8, 4)}
				</span>
			),
		},
		{
			key: 'sender',
			header: 'Sender',
			render: (tx) => (
				<span className="mono" style={{ color: 'var(--c-magenta)', fontSize: 12 }}>
					{tx.sender ? truncateMiddle(tx.sender, 6, 4) : '—'}
				</span>
			),
		},
		{
			key: 'kind',
			header: 'Kind',
			render: (tx) => <span style={{ fontSize: 12, color: 'var(--tx-mid)' }}>{tx.kind}</span>,
		},
		{
			key: 'gas',
			header: 'Gas',
			align: 'right',
			render: (tx) => (
				<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
					{tx.gas.toLocaleString()}
				</span>
			),
			sortVal: (tx) => tx.gas,
		},
		{
			key: 'status',
			header: 'Status',
			width: 70,
			render: (tx) => <Dot token={tx.status === 'success' ? 'green' : 'red'} />,
		},
		{
			key: 'when',
			header: 'When',
			align: 'right',
			render: (tx) => (
				<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-dim)' }}>
					{tx.timestampMs != null ? timeAgo(tx.timestampMs) : '—'}
				</span>
			),
			sortVal: (tx) => tx.timestampMs ?? 0,
		},
	];

	return (
		<>
			{!unreachable && (
				<Banner
					tone="info"
					title={`Connected to ${projection.identity.network}${
						headData?.chainId ? ` · chain ${headData.chainId}` : ''
					}`}
				>
					Live chain reads over the local node's gRPC endpoint. Lists walk back from the head
					checkpoint; no history is fabricated.
				</Banner>
			)}

			{/* KPI row — all live chain reads. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
					gap: 14,
				}}
			>
				<Kpi
					label="Epoch"
					value={dash(headData?.epoch ?? epochData?.epoch)}
					sub={progress != null ? `${progress}% elapsed` : undefined}
					icon="clock"
				/>
				<Kpi
					label="Checkpoint"
					value={headData ? headData.checkpoint.toLocaleString() : '—'}
					token="cyan"
					icon="box"
					live
				/>
				<Kpi
					label="Total tx"
					value={
						headData?.totalTransactions != null ? headData.totalTransactions.toLocaleString() : '—'
					}
					sub="since genesis"
					token="magenta"
					icon="hash"
				/>
				<Kpi
					label={isTps ? 'TPS' : 'Throughput'}
					value={rate != null ? rate.toFixed(2) : '—'}
					sub={isTps ? 'tx / s' : 'cp / s'}
					token="green"
					icon="activity"
					live={rate != null}
				/>
				<Kpi label="Protocol" value={dash(epochData?.protocolVersion)} sub="version" icon="hash" />
				<Kpi
					label="Ref gas"
					value={gas.data != null ? gas.data.toLocaleString() : '—'}
					sub="MIST"
					token="green"
					icon="zap"
				/>
				<Kpi
					label="Lowest cp"
					value={
						headData?.lowestAvailableCheckpoint != null
							? headData.lowestAvailableCheckpoint.toLocaleString()
							: '—'
					}
					sub="available"
					icon="layers"
				/>
			</div>

			{/* Latest transactions + packages. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1.4fr 1fr',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '14px 18px' }}>
						<SectionHead title="Latest transactions" />
					</div>
					{txs.isLoading ? (
						<SkeletonRows rows={6} cols={5} />
					) : txs.isError ? (
						<div className="panel-pad">
							<Banner tone="danger" title="Couldn't load transactions">
								The node rejected the checkpoint read. It may still be starting up.
							</Banner>
						</div>
					) : (
						<DataTable
							columns={columns}
							rows={txs.data ?? []}
							rowKey={(tx) => tx.digest}
							onRowClick={(tx) => gotoTx(tx.digest)}
							empty={<EmptyState icon="hash" title="No transactions yet" />}
						/>
					)}
				</Panel>

				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '14px 18px' }}>
						<SectionHead title="Packages" count={packages.length} />
					</div>
					<div className="col" style={{ padding: '0 0 8px' }}>
						{packages.length === 0 && (
							<div style={{ padding: '0 18px 12px' }}>
								<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>
									No packages published or tracked yet.
								</span>
							</div>
						)}
						{packages.map((p) => {
							const ours = p.kind === 'local';
							return (
								<button
									key={p.key}
									type="button"
									className="row between activity-row"
									onClick={() => gotoPackage(p.packageId)}
									style={{
										cursor: 'pointer',
										background: 'transparent',
										border: 'none',
										textAlign: 'left',
										width: '100%',
									}}
								>
									<div className="row" style={{ gap: 9 }}>
										<Dot token={ours ? 'blue' : 'white'} />
										<div>
											<div style={{ fontWeight: 530, fontSize: 13 }}>
												{p.name}
												{ours && (
													<span
														className="badge"
														style={{
															height: 17,
															fontSize: 9.5,
															color: 'var(--c-blue)',
															marginLeft: 4,
														}}
													>
														published here
													</span>
												)}
											</div>
											<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)' }}>
												{truncateMiddle(p.packageId, 8, 4)}
												{p.upgradeCapId ? ` · upgradeable` : ''}
											</span>
										</div>
									</div>
									<Icon name="chevR" size={15} style={{ color: 'var(--tx-dim)' }} />
								</button>
							);
						})}
					</div>
				</Panel>
			</div>
		</>
	);
};
