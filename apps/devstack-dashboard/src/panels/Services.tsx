// Services panel — the section-grouped table of every resource the supervisor
// manages, plus a right-hand detail drawer (lifecycle, errors, endpoints, log
// tail, recent events, and restart/apply controls). The drawer is local
// `selected` state — not routing — so opening a service is a transient overlay.

import { useCallback, useEffect, useState } from 'react';
import { applyStack, type CommandResult, restartPlugin } from '../lib/api.ts';
import {
	groupRows,
	labelForRow,
	ownerForRow,
	rowNarration,
	statusDisplay,
	visibleEndpointsForRow,
} from '../lib/derive.ts';
import { clockTime, displayHost } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { useToast } from '../lib/toast.tsx';
import type { Endpoint, Row } from '../lib/types.ts';
import {
	Badge,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EndpointLink,
	ErrorPanel,
	Icon,
	IconButton,
	Panel,
	StatusBadge,
} from '../ui/index.ts';
import type { ActivityItem, PanelProps } from './types.ts';

export const ServicesPanel = ({ projection, activity, endpoint, refresh }: PanelProps) => {
	const { rows, endpoints } = projection;
	const groups = groupRows(rows);
	const [selected, setSelected] = useState<string | null>(null);
	const selectedRow = selected ? (rows.find((r) => r.key === selected) ?? null) : null;

	const columns: ReadonlyArray<Column<Row>> = [
		{
			key: 'status',
			header: 'Status',
			width: 130,
			render: (row) => <StatusBadge status={row.status} />,
		},
		{
			key: 'service',
			header: 'Service',
			render: (row) => (
				<div className="col" style={{ gap: 1 }}>
					<span style={{ fontWeight: 540 }}>{labelForRow(row.key)}</span>
					<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)' }}>
						{row.key}
					</span>
				</div>
			),
		},
		{
			key: 'phase',
			header: 'Phase',
			render: (row) => (
				<div
					className="trunc"
					style={{
						color: row.status === 'failed' ? 'var(--c-red)' : 'var(--tx-mid)',
						fontSize: 12.5,
						maxWidth: 260,
					}}
				>
					{rowNarration(row)}
				</div>
			),
		},
		{
			key: 'role',
			header: 'Role',
			render: (row) => <Badge style={{ height: 19, fontSize: 11 }}>{row.role}</Badge>,
		},
		{
			key: 'owner',
			header: 'Owner',
			render: (row) => {
				const owner = ownerForRow(row.key) ?? 'system';
				return owner === 'system' ? (
					<span style={{ color: 'var(--tx-lo)', fontSize: 12 }}>system</span>
				) : (
					<span style={{ color: 'var(--tx-mid)', fontSize: 12 }}>{owner}</span>
				);
			},
		},
		{
			key: 'endpoints',
			header: 'Endpoints',
			render: (row) => {
				const eps = visibleEndpointsForRow(row, endpoints);
				return (
					<div className="row wrap" style={{ gap: 5 }}>
						{eps.length ? (
							eps.map((e) => <EndpointLink key={e.endpointKey} endpoint={e} />)
						) : (
							<span style={{ color: 'var(--tx-dim)' }}>—</span>
						)}
					</div>
				);
			},
		},
		{
			key: 'chev',
			header: '',
			width: 40,
			render: () => <Icon name="chevR" size={15} style={{ color: 'var(--tx-dim)' }} />,
		},
	];

	return (
		<div className="col" style={{ gap: 18 }}>
			<div className="row between wrap" style={{ gap: 12 }}>
				<div>
					<h2 style={{ fontSize: 19 }}>Services &amp; Plugins</h2>
					<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
						Every resource the supervisor manages, grouped by role. Click a row for lifecycle &amp;
						controls.
					</p>
				</div>
			</div>

			{groups.map((group) => (
				<Panel key={group.section} header={<span className="eyebrow">{group.label}</span>}>
					<DataTable
						columns={columns}
						rows={group.rows}
						rowKey={(r) => r.key}
						onRowClick={(r) => setSelected(r.key)}
					/>
				</Panel>
			))}

			{selectedRow && (
				<ServiceDrawer
					row={selectedRow}
					endpoints={endpoints}
					activity={activity}
					endpoint={endpoint}
					refresh={refresh}
					onClose={() => setSelected(null)}
				/>
			)}
		</div>
	);
};

interface ServiceDrawerProps {
	readonly row: Row;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly activity: ReadonlyArray<ActivityItem>;
	readonly endpoint: string;
	readonly refresh: () => Promise<void>;
	readonly onClose: () => void;
}

const ServiceDrawer = ({
	row,
	endpoints,
	activity,
	endpoint,
	refresh,
	onClose,
}: ServiceDrawerProps) => {
	const { error, success } = useToast();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	const run = useCallback(
		async (action: () => Promise<CommandResult>) => {
			if (busy) return;
			setBusy(true);
			try {
				const result = await action();
				if (result.ok) success(result.message ?? `${result.command} ok`);
				else error(result.message ?? `${result.command} failed`);
				await refresh();
			} catch (err) {
				error(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[busy, error, success, refresh],
	);

	const display = statusDisplay(row.status);
	const failed = row.status === 'failed';
	const eps = visibleEndpointsForRow(row, endpoints);
	const events = activity.filter((e) => e.pluginKey === row.key).slice(0, 8);
	const logLines = row.logTail.lines;

	return (
		<div className="overlay overlay-right" onClick={onClose}>
			<div className="sheet fade-right" onClick={(e) => e.stopPropagation()}>
				<div
					className="row between"
					style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }}
				>
					<div className="row" style={{ gap: 11 }}>
						<Dot token={display.token} pulse={display.pulse} />
						<div>
							<h3 style={{ fontSize: 16 }}>{labelForRow(row.key)}</h3>
							<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
								{row.key} · {row.role}
							</span>
						</div>
					</div>
					<IconButton icon="x" label="Close" onClick={onClose} />
				</div>

				<div
					className="scroll-y"
					style={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}
				>
					<div className="row between">
						<StatusBadge status={row.status} />
						<span
							className="trunc"
							style={{
								color: failed ? 'var(--c-red)' : 'var(--tx-mid)',
								fontSize: 12.5,
							}}
						>
							{row.phase ?? ''}
						</span>
					</div>

					{failed && row.lastError && <ErrorPanel error={row.lastError} />}

					{eps.length > 0 && (
						<div>
							<div className="eyebrow" style={{ marginBottom: 8 }}>
								Endpoints
							</div>
							<div className="col" style={{ gap: 6 }}>
								{eps.map((e) => (
									<div key={e.endpointKey} className="row between">
										<EndpointLink endpoint={e} />
										<CopyChip text={e.url} display={displayHost(e)} />
									</div>
								))}
							</div>
						</div>
					)}

					<div className="grow">
						<div className="eyebrow row" style={{ marginBottom: 8, gap: 6 }}>
							Log tail
							<span className={`dot dot-${row.logTail.level === 'error' ? 'red' : 'cyan'}`} />
						</div>
						<div className="logbox mono">
							{logLines.length ? (
								logLines.map((line, i) => (
									<div key={i} className="logline">
										<span style={{ color: 'var(--tx-hi)', fontSize: 11.5 }}>{line}</span>
									</div>
								))
							) : (
								<span style={{ color: 'var(--tx-dim)', fontSize: 11.5 }}>No log output.</span>
							)}
							{row.logTail.truncated && (
								<div
									className="logline"
									style={{ color: 'var(--tx-dim)', fontSize: 11, fontStyle: 'italic' }}
								>
									… output truncated
								</div>
							)}
						</div>
					</div>

					<div>
						<div className="eyebrow" style={{ marginBottom: 8 }}>
							Recent events
						</div>
						<div className="col" style={{ gap: 4 }}>
							{events.length ? (
								events.map((ev) => (
									<div key={ev.id} className="row" style={{ gap: 8 }}>
										<Dot token={ev.kind === 'error' ? 'red' : 'cyan'} />
										<span className="trunc grow" style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
											{ev.text}
										</span>
										<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)' }}>
											{clockTime(ev.at)}
										</span>
									</div>
								))
							) : (
								<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>
									No events this cycle.
								</span>
							)}
						</div>
					</div>
				</div>

				<div
					className="row"
					style={{ gap: 9, padding: '14px 20px', borderTop: '1px solid var(--line)' }}
				>
					<button
						className="btn grow"
						disabled={busy}
						onClick={() => void run(() => restartPlugin(endpoint, row.key))}
					>
						<Icon name="refresh" size={14} /> Restart
					</button>
					<button
						className="btn"
						disabled={busy}
						onClick={() => void run(() => applyStack(endpoint, row.key))}
					>
						<Icon name="zap" size={14} /> Apply
					</button>
					<IconButton
						icon="terminal"
						label="Open in console"
						onClick={() => navigate('activity')}
					/>
				</div>
			</div>
		</div>
	);
};
