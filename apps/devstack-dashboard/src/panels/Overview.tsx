// Overview panel — the dashboard's landing screen. A KPI row, an optional
// failed-services banner, and a two-column body (Stack status on the left,
// Endpoints + Recent activity on the right). Everything is derived from the
// live `projection` + client `activity` feed via the `lib/` seams; no values
// are fabricated.

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
import {
	CopyChip,
	Dot,
	EndpointLink,
	ErrorPanel,
	Icon,
	Kpi,
	Panel,
	SectionHead,
} from '../ui/index.ts';
import type { PanelProps } from './types.ts';

const RECENT_ACTIVITY_LIMIT = 7;
const ENDPOINTS_PREVIEW = 6;

export const OverviewPanel = ({ projection, activity }: PanelProps) => {
	const { rows, endpoints, accounts, packages, errors, cycle } = projection;

	const health = summarize(rows);
	const fundedAccounts = accounts.filter((a) => a.funding.status === 'funded').length;
	const groups = groupRows(rows);
	const failed = rows.filter((r) => r.status === 'failed');
	const showBanner = health.failed > 0 || errors.length > 0;
	const bannerError = failed[0]?.lastError ?? errors[0] ?? null;
	const recent = activity.slice(0, RECENT_ACTIVITY_LIMIT);

	return (
		<div className="col" style={{ gap: 22 }}>
			{/* KPI row — 4 tiles backed by real projection counts. */}
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
