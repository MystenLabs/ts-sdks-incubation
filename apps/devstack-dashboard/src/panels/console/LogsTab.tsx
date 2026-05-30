// Logs tab — unified live console across every per-service log ring buffer.
//
// The backend keeps a per-service ring so a crashed/quiet service's errors
// survive; the Service filter is the prominent first control and defaults to
// "all services". Error/fatal lines are rendered unmissable (red message + a
// tinted row with a left rail). Polls `fetchLogs(endpoint, filter)` via
// react-query — Service/Level/search map straight onto the backend `LogFilter`
// (`services`/`levels`/`search`), and follow/pause governs auto-scroll.

import { type ChangeEvent, type UIEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLogs, fetchLogServices, type LogRecord } from '../../lib/api.ts';
import { labelForRow } from '../../lib/derive.ts';
import { useToast } from '../../lib/toast.tsx';
import { Dot, EmptyState, Icon, LevelPill, MultiSelect, Skeleton } from '../../ui/index.ts';
import {
	clock24,
	formatFields,
	isErrorLevel,
	LEVEL_OPTIONS,
	LOG_VISIBLE_CAP,
	logKey,
	logMessageColor,
	pillLevel,
	toggleInSet,
} from './shared.ts';

const POLL_MS = 1500;
const AT_BOTTOM_SLACK = 40;

export const LogsTab = ({ endpoint }: { readonly endpoint: string }) => {
	const toast = useToast();
	const [services, setServices] = useState<ReadonlyArray<string>>([]);
	const [levels, setLevels] = useState<ReadonlyArray<string>>([]);
	const [query, setQuery] = useState('');
	const [follow, setFollow] = useState(true);
	const [unseen, setUnseen] = useState(0);

	const scroller = useRef<HTMLDivElement>(null);
	// Count of records at the last auto-scroll, so we can derive a "N new" delta.
	const lastSeenCount = useRef(0);

	const toggle =
		(set: (fn: (cur: ReadonlyArray<string>) => ReadonlyArray<string>) => void) => (value: string) =>
			set((cur) => toggleInSet(cur, value));

	// Service filter options (distinct services that have emitted logs). Honest:
	// it reflects the backend's ring set, not just currently-running services.
	const servicesQuery = useQuery({
		queryKey: ['logServices', endpoint],
		queryFn: () => fetchLogServices(endpoint),
		refetchInterval: POLL_MS * 4,
	});

	// Server-side filtering: the active facets become the `LogFilter`. We over-fetch
	// (cap) so the visible tail is dense; search is sent server-side AND refined
	// client-side for responsiveness while typing.
	const trimmedQuery = query.trim();
	const logsQuery = useQuery({
		queryKey: ['logs', endpoint, services, levels, trimmedQuery],
		queryFn: () =>
			fetchLogs(endpoint, {
				services: services.length ? services : undefined,
				levels: levels.length ? levels : undefined,
				search: trimmedQuery || undefined,
				limit: LOG_VISIBLE_CAP,
			}),
		refetchInterval: POLL_MS,
		placeholderData: (prev) => prev,
	});

	const records: ReadonlyArray<LogRecord> = useMemo(() => {
		const all = logsQuery.data ?? [];
		// Oldest→newest so following pins the newest at the bottom.
		const sorted = [...all].sort((a, b) =>
			a.timestampMillis === b.timestampMillis
				? a.seq - b.seq
				: a.timestampMillis - b.timestampMillis,
		);
		return sorted.slice(-LOG_VISIBLE_CAP);
	}, [logsQuery.data]);

	// Client-side search refinement (responsive while the debounce-free server
	// query is in flight); also matches the service tag, not just the message.
	const filtered = useMemo(() => {
		const needle = trimmedQuery.toLowerCase();
		if (!needle) return records;
		return records.filter(
			(l) =>
				l.message.toLowerCase().includes(needle) ||
				l.service.toLowerCase().includes(needle) ||
				labelForRow(l.service).toLowerCase().includes(needle),
		);
	}, [records, trimmedQuery]);

	// Follow → keep pinned to the bottom and clear the counter. Paused → accrue
	// a "N new" delta from however many records arrived since the last pin.
	useEffect(() => {
		if (follow) {
			const el = scroller.current;
			if (el) el.scrollTop = el.scrollHeight;
			lastSeenCount.current = filtered.length;
			setUnseen(0);
		} else {
			setUnseen(Math.max(0, filtered.length - lastSeenCount.current));
		}
	}, [filtered.length, follow]);

	const onScroll = (e: UIEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK;
		// Manual scroll-up pauses following; scrolling back to the bottom resumes.
		if (!atBottom && follow) setFollow(false);
		else if (atBottom && !follow) {
			setFollow(true);
			lastSeenCount.current = filtered.length;
			setUnseen(0);
		}
	};

	const exportLogs = () => {
		try {
			const text = filtered
				.map((l) => {
					const fields = formatFields(l.fields);
					return `${new Date(l.timestampMillis).toISOString()} ${l.level.toUpperCase()} ${l.service} ${l.message}${fields ? ` ${fields}` : ''}`;
				})
				.join('\n');
			const blob = new Blob([text], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `devstack-logs-${Date.now()}.log`;
			a.click();
			URL.revokeObjectURL(url);
			toast.success(`Exported ${filtered.length} log lines`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Export failed');
		}
	};

	const serviceOptions = useMemo(
		() => (servicesQuery.data ?? []).map((s) => ({ value: s, label: labelForRow(s) })),
		[servicesQuery.data],
	);

	const errorCount = useMemo(
		() => filtered.filter((l) => isErrorLevel(l.level)).length,
		[filtered],
	);
	const loading = logsQuery.isLoading;
	const queryError = logsQuery.isError
		? logsQuery.error instanceof Error
			? logsQuery.error.message
			: 'Failed to load logs'
		: null;

	return (
		<div className="col" style={{ gap: 12, height: '100%' }}>
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
						flex: '1 1 240px',
						maxWidth: 380,
					}}
				>
					<Icon name="search" size={15} style={{ color: 'var(--tx-lo)' }} />
					<input
						value={query}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						placeholder="Search messages…"
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
					label="Level"
					icon="filter"
					options={LEVEL_OPTIONS}
					selected={levels}
					onToggle={toggle(setLevels)}
				/>
				<div className="grow" />
				{errorCount > 0 && (
					<span
						className="row"
						style={{ gap: 6, fontSize: 12, color: 'var(--c-red)' }}
						title="Error/fatal lines in view — these survive even if their service crashed."
					>
						<Dot token="red" />
						{errorCount} error{errorCount === 1 ? '' : 's'}
					</span>
				)}
				<button
					className="btn btn-sm"
					onClick={() => {
						setFollow((f) => !f);
						setUnseen(0);
						lastSeenCount.current = filtered.length;
					}}
					style={follow ? { borderColor: 'var(--accent-line)', color: 'var(--accent)' } : undefined}
				>
					<Icon name={follow ? 'pause' : 'play'} size={13} />
					{follow ? 'Following' : 'Paused'}
					{!follow && unseen > 0 ? ` · ${unseen} new` : ''}
				</button>
				<button
					className="btn btn-sm btn-ghost"
					onClick={exportLogs}
					disabled={filtered.length === 0}
					title="Export visible lines"
				>
					<Icon name="download" size={14} />
				</button>
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
					Log query failed: {queryError}
				</div>
			)}

			<div ref={scroller} className="panel logbox-full mono scroll-y grow" onScroll={onScroll}>
				{loading ? (
					<div className="col" style={{ gap: 8, padding: 12 }}>
						{Array.from({ length: 8 }).map((_, i) => (
							<Skeleton key={i} w={`${50 + ((i * 7) % 45)}%`} h={13} />
						))}
					</div>
				) : filtered.length === 0 ? (
					<EmptyState
						icon="terminal"
						title="No log lines"
						hint={
							services.length || levels.length || trimmedQuery
								? 'No lines match the active filters.'
								: 'Services have not emitted any logs yet.'
						}
					/>
				) : (
					filtered.map((l) => {
						const error = isErrorLevel(l.level);
						const fieldsText = formatFields(l.fields);
						return (
							<div
								key={logKey(l)}
								className="logline"
								style={
									error
										? {
												background: 'color-mix(in oklab, var(--c-red) 9%, transparent)',
												borderLeft: '2px solid var(--c-red)',
												paddingLeft: 8,
											}
										: undefined
								}
							>
								<span style={{ color: 'var(--tx-dim)', fontSize: 11 }}>
									{clock24(l.timestampMillis)}
								</span>
								<LevelPill level={pillLevel(l.level)} />
								<span
									style={{ color: 'var(--tx-lo)', fontSize: 11.5, minWidth: 96 }}
									title={l.service}
								>
									{labelForRow(l.service)}
								</span>
								<span
									style={{
										color: logMessageColor(l.level),
										fontSize: 12.5,
										flex: 1,
										fontWeight: error ? 560 : undefined,
									}}
								>
									{l.message}
								</span>
								{fieldsText && (
									<span style={{ color: 'var(--tx-dim)', fontSize: 11 }}>{fieldsText}</span>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
};
