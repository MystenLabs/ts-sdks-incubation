// Traces tab — completed spans from the in-memory SpanStore tracer, queried via
// `fetchSpans(endpoint, filter)`. Service/Status/search map onto the backend
// `SpanFilter` (`services`/`statuses`/`search`). Each row: a status dot, the
// mono operation (`name`), a service badge, a duration `Meter` (scaled to the
// slowest visible span) + ms, relative time, and an ok/error status label.

import { type ChangeEvent, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSpans, fetchSpanServices, type SpanRecord } from '../../lib/api.ts';
import { labelForRow } from '../../lib/derive.ts';
import { timeAgo } from '../../lib/format.ts';
import {
	Badge,
	Banner,
	type Column,
	DataTable,
	Dot,
	Icon,
	Meter,
	MultiSelect,
	SkeletonRows,
} from '../../ui/index.ts';
import { STATUS_OPTIONS } from './shared.ts';

const POLL_MS = 2000;
const SPAN_LIMIT = 400;

const isError = (status: string): boolean => status !== 'ok' && status !== 'unset';

export const TracesTab = ({ endpoint }: { readonly endpoint: string }) => {
	const [services, setServices] = useState<ReadonlyArray<string>>([]);
	const [statuses, setStatuses] = useState<ReadonlyArray<string>>([]);
	const [query, setQuery] = useState('');

	const toggle =
		(set: (fn: (cur: ReadonlyArray<string>) => ReadonlyArray<string>) => void) => (value: string) =>
			set((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));

	const trimmed = query.trim();

	const servicesQuery = useQuery({
		queryKey: ['spanServices', endpoint],
		queryFn: () => fetchSpanServices(endpoint),
		refetchInterval: POLL_MS * 3,
	});

	const spansQuery = useQuery({
		queryKey: ['spans', endpoint, services, statuses, trimmed],
		queryFn: () =>
			fetchSpans(endpoint, {
				services: services.length ? services : undefined,
				statuses: statuses.length ? statuses : undefined,
				search: trimmed || undefined,
				limit: SPAN_LIMIT,
			}),
		refetchInterval: POLL_MS,
		placeholderData: (prev) => prev,
	});

	const spans = useMemo(() => {
		const all = spansQuery.data ?? [];
		// Newest-first by start time.
		return [...all].sort((a, b) => b.startMillis - a.startMillis);
	}, [spansQuery.data]);

	const maxDur = useMemo(
		() => Math.max(1, ...spans.map((s) => s.durationMillis)),
		[spans],
	);

	const serviceOptions = useMemo(
		() => (servicesQuery.data ?? []).map((s) => ({ value: s, label: labelForRow(s) })),
		[servicesQuery.data],
	);

	const columns: ReadonlyArray<Column<SpanRecord>> = useMemo(
		() => [
			{
				key: 'status-dot',
				header: '',
				width: 30,
				render: (s) => <Dot token={isError(s.status) ? 'red' : 'green'} />,
			},
			{
				key: 'op',
				header: 'Operation',
				sortVal: (s) => s.name,
				render: (s) => (
					<span className="mono" style={{ fontSize: 12.5, color: 'var(--tx-hi)' }} title={s.traceId}>
						{s.name}
					</span>
				),
			},
			{
				key: 'service',
				header: 'Service',
				sortVal: (s) => s.service ?? '',
				render: (s) =>
					s.service ? (
						<Badge style={{ height: 19, fontSize: 11 }}>{labelForRow(s.service)}</Badge>
					) : (
						<span style={{ color: 'var(--tx-dim)', fontSize: 11.5 }}>—</span>
					),
			},
			{
				key: 'duration',
				header: 'Duration',
				width: '40%',
				sortVal: (s) => s.durationMillis,
				render: (s) => {
					const err = isError(s.status);
					return (
						<div className="row" style={{ gap: 9 }}>
							<div className="grow" style={{ maxWidth: 240 }}>
								<Meter value={s.durationMillis / maxDur} token={err ? 'red' : 'blue'} />
							</div>
							<span
								className="mono tnum"
								style={{ fontSize: 12, color: 'var(--tx-lo)', minWidth: 56 }}
							>
								{s.durationMillis.toFixed(1)}ms
							</span>
						</div>
					);
				},
			},
			{
				key: 'when',
				header: 'When',
				width: 70,
				align: 'right',
				sortVal: (s) => s.startMillis,
				render: (s) => (
					<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-dim)' }}>
						{timeAgo(s.startMillis)}
					</span>
				),
			},
			{
				key: 'status',
				header: 'Status',
				width: 72,
				sortVal: (s) => s.status,
				render: (s) => {
					const err = isError(s.status);
					return (
						<span
							style={{ fontSize: 11.5, fontWeight: 540, color: err ? 'var(--c-red)' : 'var(--c-green)' }}
						>
							{err ? 'error' : 'ok'}
						</span>
					);
				},
			},
		],
		[maxDur],
	);

	const queryError = spansQuery.isError
		? spansQuery.error instanceof Error
			? spansQuery.error.message
			: 'Failed to load spans'
		: null;

	return (
		<div className="col" style={{ gap: 12, height: '100%' }}>
			<Banner
				tone="info"
				className="shrink-0"
				title={
					<span>
						Spans collected by the in-memory{' '}
						<span className="mono" style={{ color: 'var(--c-blue)' }}>
							SpanStore
						</span>{' '}
						tracer
					</span>
				}
			>
				Indexed by{' '}
				<span className="mono">devstack.plugin / endpoint / op</span> — newest first.
			</Banner>

			<div className="row wrap" style={{ gap: 9 }}>
				<div
					className="row"
					style={{
						gap: 8,
						background: 'var(--bg-panel)',
						border: '1px solid var(--line)',
						borderRadius: 'var(--r-sm)',
						padding: '0 10px',
						height: 32,
						flex: '1 1 220px',
						maxWidth: 340,
					}}
				>
					<Icon name="search" size={15} style={{ color: 'var(--tx-lo)' }} />
					<input
						value={query}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						placeholder="Search operations…"
						style={{
							background: 'transparent',
							border: 'none',
							outline: 'none',
							color: 'var(--tx-hi)',
							fontSize: 13,
							flex: 1,
							fontFamily: 'var(--font-mono)',
						}}
					/>
					{query && (
						<button
							className="iconbtn"
							style={{ width: 22, height: 22 }}
							onClick={() => setQuery('')}
							aria-label="Clear search"
						>
							<Icon name="x" size={13} />
						</button>
					)}
				</div>
				<MultiSelect
					label="Service"
					icon="layers"
					options={serviceOptions}
					selected={services}
					onToggle={toggle(setServices)}
				/>
				<MultiSelect
					label="Status"
					icon="filter"
					options={STATUS_OPTIONS}
					selected={statuses}
					onToggle={toggle(setStatuses)}
				/>
			</div>

			{queryError && (
				<div
					className="row"
					style={{
						gap: 9,
						padding: '8px 12px',
						borderRadius: 9,
						background: 'color-mix(in oklab, var(--c-red) 7%, var(--bg-panel))',
						border: '1px solid color-mix(in oklab, var(--c-red) 34%, var(--line))',
						fontSize: 12.5,
						color: 'var(--tx-mid)',
					}}
				>
					<Icon name="alert" size={15} style={{ color: 'var(--c-red)' }} />
					Span query failed: {queryError}
				</div>
			)}

			<div className="panel scroll-y grow" style={{ padding: '8px 0' }}>
				{spansQuery.isLoading ? (
					<SkeletonRows rows={7} cols={5} />
				) : (
					<DataTable
						columns={columns}
						rows={spans}
						rowKey={(s) => s.spanId}
						empty={
							<div style={{ padding: '36px 20px', textAlign: 'center', color: 'var(--tx-lo)' }}>
								<div style={{ color: 'var(--tx-mid)', fontWeight: 540, marginBottom: 4 }}>
									No spans collected
								</div>
								<div style={{ fontSize: 12.5 }}>
									{services.length || statuses.length || trimmed
										? 'No spans match the active filters.'
										: 'Operations appear here as the tracer records them.'}
								</div>
							</div>
						}
					/>
				)}
			</div>
		</div>
	);
};
