// Overview panel — the dashboard's landing screen. A KPI row, an optional
// failed-services banner, and a two-column body (Stack status on the left,
// Endpoints + Recent activity on the right). Everything is derived from the
// live `projection` + client `activity` feed via the `lib/` seams; no values
// are fabricated.
//
// Live chain KPIs (Checkpoint + TPS) read browser-direct from the node via
// `useChainHead`. TPS is a REAL transactions-per-second figure derived from
// Δ(totalTransactions)/Δt between head ticks, where `totalTransactions` is the
// head checkpoint's `total_network_transactions` running count. There is no
// historical series source today, so the only trend visuals are HONEST rolling
// mini-series accumulated from live head ticks while this panel is mounted —
// empty on first paint, filling as the head advances. The design's "tx / day"
// bar + "active accounts" area charts are omitted: no real series feeds them.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
	groupRows,
	healthToken,
	labelForRow,
	rowNarration,
	sectionToken,
	statusDisplay,
	summarize,
} from '../lib/derive.ts';
import { displayHost, timeAgo } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { useChainHead } from '../lib/useChain.ts';
import {
	CopyChip,
	Dot,
	EndpointLink,
	ErrorPanel,
	Icon,
	Kpi,
	Panel,
	SectionHead,
	Sparkline,
} from '../ui/index.ts';
import type { PanelProps } from './types.ts';

const RECENT_ACTIVITY_LIMIT = 7;
const ENDPOINTS_PREVIEW = 6;
const SERIES_CAP = 24;

/**
 * A short rolling numeric series accumulated from live ticks. `sample` is fed a
 * fresh value on each head update; identical consecutive values are skipped so
 * the series only grows when the underlying metric actually moves. Resets when
 * `resetKey` changes (e.g. switching networks). Honest by construction — it only
 * ever holds values observed while this panel was mounted.
 */
const useRollingSeries = (resetKey: string): readonly [ReadonlyArray<number>, (v: number) => void] => {
	const [series, setSeries] = useState<ReadonlyArray<number>>([]);
	const last = useRef<number | null>(null);
	useEffect(() => {
		last.current = null;
		setSeries([]);
	}, [resetKey]);
	const sample = (v: number) => {
		if (!Number.isFinite(v) || last.current === v) return;
		last.current = v;
		setSeries((prev) => [...prev, v].slice(-SERIES_CAP));
	};
	return [series, sample];
};

export const OverviewPanel = ({ projection, activity, chain }: PanelProps) => {
	const { rows, endpoints, accounts, packages, errors, cycle } = projection;

	const health = summarize(rows);
	const fundedAccounts = accounts.filter((a) => a.funding.status === 'funded').length;
	const groups = groupRows(rows);
	const failed = rows.filter((r) => r.status === 'failed');
	const showBanner = health.failed > 0 || errors.length > 0;
	const bannerError = failed[0]?.lastError ?? errors[0] ?? null;
	const recent = activity.slice(0, RECENT_ACTIVITY_LIMIT);

	// Live head — refetches every ~2s (see useChain). We roll checkpoint numbers
	// into one mini-series and derive a REAL tx/s (TPS) from consecutive
	// Δ(totalTransactions)/Δt deltas, where `totalTransactions` is the head
	// checkpoint's running `total_network_transactions`. If that count is
	// genuinely unavailable we fall back to the honest checkpoint rate (cp/s).
	const head = useChainHead(chain);
	const [cpSeries, sampleCp] = useRollingSeries(chain.network);
	const [rateSeries, sampleRate] = useRollingSeries(chain.network);
	const prev = useRef<{ cp: number; tx: number | null; t: number } | null>(null);
	const [rate, setRate] = useState<number | null>(null);
	// Whether the head exposes a real total-transaction count (drives the label).
	const [hasTps, setHasTps] = useState(false);

	const checkpoint = head.data?.checkpoint ?? null;
	const totalTx = head.data?.totalTransactions ?? null;
	const headTs = head.data?.timestampMs ?? null;
	useEffect(() => {
		if (checkpoint === null) return;
		sampleCp(checkpoint);
		const now = headTs ?? Date.now();
		const last = prev.current;
		if (last && now > last.t) {
			const dt = now - last.t;
			// Prefer real TPS from the transaction-total delta; fall back to cp/s.
			let value: number | null = null;
			if (totalTx !== null && last.tx !== null) {
				const tps = ((totalTx - last.tx) * 1000) / dt;
				if (Number.isFinite(tps) && tps >= 0) {
					value = tps;
					setHasTps(true);
				}
			}
			if (value === null) {
				const cps = ((checkpoint - last.cp) * 1000) / dt;
				if (Number.isFinite(cps) && cps >= 0) value = cps;
			}
			if (value !== null) {
				setRate(value);
				sampleRate(Number(value.toFixed(2)));
			}
		}
		prev.current = { cp: checkpoint, tx: totalTx, t: now };
		// eslint-disable-next-line react-hooks/exhaustive-deps -- sample fns are stable enough; keyed off head movement only
	}, [checkpoint, totalTx, headTs]);

	const chainLive = chain.rpcUrl !== null;

	return (
		<div className="col" style={{ gap: 22 }}>
			{/* KPI row — projection counts + live browser-direct chain head. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
					gap: 14,
				}}
			>
				<Kpi
					label="Services"
					value={`${health.ready}/${health.total}`}
					sub="ready"
					token={healthToken(health.health)}
					icon="layers"
				/>
				{chainLive && (
					<LiveKpi spark={cpSeries.length > 1 ? cpSeries : null} sparkType="line" sparkColor="var(--c-cyan)">
						<Kpi
							label="Checkpoint"
							value={checkpoint !== null ? checkpoint.toLocaleString() : '—'}
							sub={head.data ? `epoch ${head.data.epoch}` : 'connecting…'}
							token="cyan"
							icon="box"
							live={checkpoint !== null}
						/>
					</LiveKpi>
				)}
				{chainLive && (
					<LiveKpi spark={rateSeries.length > 1 ? rateSeries : null} sparkColor="var(--c-green)">
						<Kpi
							label="Throughput"
							value={rate !== null ? rate.toFixed(2) : '—'}
							sub={hasTps ? 'TPS' : 'cp / s'}
							token="green"
							icon="activity"
							live={rate !== null}
						/>
					</LiveKpi>
				)}
				<Kpi
					label="Accounts"
					value={`${fundedAccounts}/${accounts.length}`}
					sub="funded"
					token="magenta"
					icon="wallet"
				/>
				<Kpi label="Packages" value={packages.length} sub="tracked" token="blue" icon="box" />
				<Kpi
					label="Uptime"
					value={timeAgo(cycle.startedAt)}
					sub={`cycle #${cycle.id}`}
					icon="clock"
				/>
			</div>

			{/* TODO(overview-charts): the design shows a "tx / day" BarChart and an
			    "active accounts" AreaChart. Both need a real historical series the
			    node/projection does not expose today (no per-day tx counts, no
			    active-account history). Omitted rather than fabricated — wire them
			    once a real time-series source (indexer rollup) lands. */}

			{/* Failed-services banner. */}
			{showBanner && (
				<Panel
					pad
					className="fade-up"
					style={{
						borderColor: 'color-mix(in oklab, var(--c-red) 34%, var(--line))',
						background: 'color-mix(in oklab, var(--c-red) 6%, var(--bg-panel))',
					}}
				>
					<div className="row" style={{ gap: 11 }}>
						<Icon name="alert" size={18} style={{ color: 'var(--c-red)', flex: 'none' }} />
						<div className="grow">
							<div style={{ fontWeight: 560, marginBottom: 2 }}>
								{health.failed} service{health.failed === 1 ? '' : 's'} need
								{health.failed === 1 ? 's' : ''} attention
							</div>
							<div className="trunc" style={{ color: 'var(--tx-mid)', fontSize: 12.5 }}>
								{failed.map((r) => labelForRow(r.key)).join(', ') || 'Stack errors'}
							</div>
						</div>
						<button className="btn btn-sm" onClick={() => navigate('services')}>
							Inspect
						</button>
					</div>
					{bannerError && (
						<div style={{ marginTop: 11 }}>
							<ErrorPanel error={bannerError} />
						</div>
					)}
				</Panel>
			)}

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1.55fr 1fr',
					gap: 22,
					alignItems: 'start',
				}}
			>
				{/* Stack status — section-grouped rows. */}
				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ paddingBottom: 0 }}>
						<SectionHead
							title="Stack status"
							count={rows.length}
							right={
								<button className="btn btn-sm btn-ghost" onClick={() => navigate('services')}>
									All services <Icon name="arrowR" size={13} />
								</button>
							}
						/>
					</div>
					<div className="col" style={{ padding: '4px 0 8px' }}>
						{groups.map((group) => (
							<div key={group.section}>
								<div className="eyebrow" style={{ padding: '10px 18px 6px' }}>
									{group.label}
								</div>
								{group.rows.map((row) => {
									const display = statusDisplay(row.status);
									const failedRow = row.status === 'failed';
									const narration = rowNarration(row);
									return (
										<div
											key={row.key}
											className="row"
											onClick={() => navigate('services', row.key)}
											style={{ padding: '8px 18px', gap: 12, cursor: 'pointer' }}
											onMouseEnter={(e) => {
												e.currentTarget.style.background = 'var(--bg-hover)';
											}}
											onMouseLeave={(e) => {
												e.currentTarget.style.background = 'transparent';
											}}
										>
											<Dot token={display.token} pulse={display.pulse} />
											<span style={{ fontWeight: 530, minWidth: 132 }}>{labelForRow(row.key)}</span>
											<span
												className="trunc grow"
												style={{
													color: failedRow ? 'var(--c-red)' : 'var(--tx-mid)',
													fontSize: 12.5,
												}}
											>
												{narration}
											</span>
											<span
												style={{
													color: `var(--c-${display.token})`,
													fontSize: 12,
													fontWeight: 540,
												}}
											>
												{display.label}
											</span>
										</div>
									);
								})}
							</div>
						))}
					</div>
				</Panel>

				{/* Right column: endpoints + recent activity. */}
				<div className="col" style={{ gap: 22 }}>
					<Panel pad>
						<SectionHead title="Endpoints" count={endpoints.length} />
						<div className="col" style={{ gap: 7 }}>
							{endpoints.slice(0, ENDPOINTS_PREVIEW).map((ep) => (
								<div key={ep.endpointKey} className="row between" style={{ gap: 8 }}>
									<EndpointLink endpoint={ep} />
									<CopyChip text={ep.url} display={displayHost(ep)} />
								</div>
							))}
							{endpoints.length === 0 && (
								<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>
									No endpoints registered.
								</span>
							)}
						</div>
					</Panel>

					<Panel pad>
						<SectionHead
							title="Recent activity"
							right={
								<button className="btn btn-sm btn-ghost" onClick={() => navigate('activity')}>
									Open feed <Icon name="arrowR" size={13} />
								</button>
							}
						/>
						<div className="col" style={{ gap: 2 }}>
							{recent.map((ev) => (
								<div key={ev.id} className="row fade-up" style={{ gap: 9, padding: '5px 0' }}>
									<Dot token={sectionToken(ev.section)} />
									<span className="trunc grow" style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
										{ev.text}
									</span>
									<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)' }}>
										{timeAgo(ev.at)}
									</span>
								</div>
							))}
							{recent.length === 0 && (
								<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>
									No activity this cycle.
								</span>
							)}
						</div>
					</Panel>
				</div>
			</div>
		</div>
	);
};

/**
 * Overlays a live rolling Sparkline into the bottom-right of a `Kpi` tile. The
 * `Kpi` atom takes no children, so we wrap it in a relative container and pin
 * the trend chart over the tile's lower corner — only rendered once the rolling
 * series has more than one observed sample.
 */
const LiveKpi = ({
	children,
	spark,
	sparkColor,
	sparkType = 'area',
}: {
	readonly children: ReactNode;
	readonly spark: ReadonlyArray<number> | null;
	readonly sparkColor: string;
	readonly sparkType?: 'area' | 'line';
}) => (
	<div style={{ position: 'relative', minWidth: 0 }}>
		{children}
		{spark && (
			<div
				style={{
					position: 'absolute',
					right: 12,
					bottom: 10,
					pointerEvents: 'none',
					opacity: 0.85,
				}}
			>
				<Sparkline data={spark} type={sparkType} color={sparkColor} width={84} height={26} />
			</div>
		)}
	</div>
);
