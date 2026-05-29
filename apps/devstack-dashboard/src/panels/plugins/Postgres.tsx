// Postgres plugin view — the indexer datastore surface.
//
// Real data: `fetchPostgresStats(endpoint)` (control-plane GraphQL; the browser
// can't speak the PG wire protocol) gives `available`, `database`, the plain
// (password-less) DSN `plainUrl`, `databaseBytes`, `connectionCount`, an
// optional `detail` string, and per-table `{ schema, name, rowEstimate,
// totalBytes }`. Health is derived from `available` (+ `detail`); the DSN bar
// copies `plainUrl`. The handoff's "index lag" KPI has NO backing field on
// `PostgresStats`, so it renders an honest "n/a" rather than a fabricated value.

import { useEffect, useState } from 'react';
import { fetchPostgresStats, type PostgresStats, restartPlugin } from '../../lib/api.ts';
import { groupDigits } from '../../lib/format.ts';
import { useToast } from '../../lib/toast.tsx';
import {
	Banner,
	type Column,
	CopyChip,
	DataTable,
	EmptyState,
	Icon,
	Kpi,
	Meter,
	Panel,
	SectionHead,
	Tooltip,
} from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

type PgTable = PostgresStats['tables'][number];

/** Human byte size (IEC), e.g. 1.4 GB. */
const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	const fixed = value >= 100 || i === 0 ? Math.round(value).toString() : value.toFixed(1);
	return `${fixed} ${units[i]}`;
};

export const PostgresView = ({ row, pluginKey, endpoint, refresh, chain }: PluginViewProps) => {
	const { success, error } = useToast();

	const [stats, setStats] = useState<PostgresStats | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setLoadErr(null);
		fetchPostgresStats(endpoint)
			.then((list) => {
				if (alive) setStats(list[0] ?? null);
			})
			.catch((err) => {
				if (alive) setLoadErr(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [endpoint, chain.network]);

	const onRestart = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const result = await restartPlugin(endpoint, row?.key ?? pluginKey);
			if (result.ok) success(result.message ?? 'Postgres restart requested');
			else error(result.message ?? 'Postgres restart failed');
			await refresh();
		} catch (err) {
			error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const available = stats?.available ?? false;
	const maxBytes = stats ? Math.max(1, ...stats.tables.map((t) => t.totalBytes)) : 1;

	return (
		<PluginScaffold
			label="Postgres"
			icon="database"
			row={row}
			subtitle="Indexer datastore · wire-protocol stats."
		>
			<div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
				<button className="btn btn-sm" disabled={busy} onClick={() => void onRestart()}>
					<Icon name="refresh" size={13} /> Restart
				</button>
			</div>

			{loadErr ? (
				<Banner tone="danger" title="Postgres stats unavailable">
					Couldn't load Postgres stats from the control plane: {loadErr}
				</Banner>
			) : loading ? (
				<Panel pad>
					<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>Loading Postgres stats…</span>
				</Panel>
			) : !stats ? (
				<Panel>
					<EmptyState
						icon="database"
						title="No Postgres in this stack"
						hint="This stack doesn't run the Postgres plugin, so there's no datastore to inspect."
					/>
				</Panel>
			) : (
				<>
					{/* DSN bar — the plain, password-less connection string. */}
					<Panel pad className="row between wrap" style={{ gap: 12 }}>
						<div className="row" style={{ gap: 12, minWidth: 0 }}>
							<Icon name="database" size={18} style={{ color: 'var(--c-blue)', flex: 'none' }} />
							<CopyChip text={stats.plainUrl} display={stats.plainUrl} />
						</div>
						<Tooltip label={`psql "${stats.plainUrl}"`}>
							<CopyChip
								text={`psql "${stats.plainUrl}"`}
								display="Open psql"
								icon="terminal"
								mono={false}
							/>
						</Tooltip>
					</Panel>

					{!available && (
						<Banner tone="warn" title="Postgres is not reporting healthy">
							The control plane couldn't gather live stats.
							{stats.detail ? ` (${stats.detail})` : ''}
						</Banner>
					)}

					{/* KPIs. */}
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
							gap: 14,
						}}
					>
						<Kpi
							label="Health"
							value={available ? 'OK' : 'Down'}
							token={available ? 'green' : 'red'}
							icon="activity"
						/>
						<Kpi
							label="Index lag"
							value={
								<Tooltip label="Index/replication lag isn't reported by the control plane.">
									<span>n/a</span>
								</Tooltip>
							}
							token="dim"
							icon="clock"
						/>
						<Kpi label="DB size" value={formatBytes(stats.databaseBytes)} icon="database" />
						<Kpi
							label="Connections"
							value={stats.connectionCount}
							token="cyan"
							icon="plug"
						/>
					</div>

					{/* Tables. */}
					<Panel header={<SectionHead title="Tables" count={stats.tables.length} />}>
						<TablesTable tables={stats.tables} maxBytes={maxBytes} />
					</Panel>
				</>
			)}
		</PluginScaffold>
	);
};

const TablesTable = ({ tables, maxBytes }: { tables: ReadonlyArray<PgTable>; maxBytes: number }) => {
	const columns: ReadonlyArray<Column<PgTable>> = [
		{
			key: 'name',
			header: 'Table',
			sortVal: (t) => `${t.schema}.${t.name}`,
			render: (t) => (
				<span className="mono" style={{ fontSize: 12.5 }}>
					{t.schema === 'public' ? (
						t.name
					) : (
						<>
							<span style={{ color: 'var(--tx-dim)' }}>{t.schema}.</span>
							{t.name}
						</>
					)}
				</span>
			),
		},
		{
			key: 'rows',
			header: 'Rows',
			align: 'right',
			width: 130,
			sortVal: (t) => t.rowEstimate,
			render: (t) => (
				<Tooltip label="Live row estimate (pg_class.reltuples).">
					<span className="mono tnum">{groupDigits(Math.round(t.rowEstimate))}</span>
				</Tooltip>
			),
		},
		{
			key: 'size',
			header: 'Size',
			align: 'right',
			width: 110,
			sortVal: (t) => t.totalBytes,
			render: (t) => (
				<span className="mono tnum" style={{ color: 'var(--tx-lo)' }}>
					{formatBytes(t.totalBytes)}
				</span>
			),
		},
		{
			key: 'fill',
			header: '',
			width: '36%',
			render: (t) => <Meter value={t.totalBytes / maxBytes} token="blue" />,
		},
	];
	return (
		<DataTable
			columns={columns}
			rows={tables}
			rowKey={(t) => `${t.schema}.${t.name}`}
			empty={
				<EmptyState
					title="No tables"
					hint="The indexer hasn't created any tables in this database yet."
				/>
			}
		/>
	);
};
