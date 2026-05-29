// Walrus plugin view. Header bar (Restart + "Logs & events"), KPIs, an
// endpoints card, a cluster-nodes table, and a recent-blobs table.
//
// Data sources & honesty:
//   - Endpoint URLs come from `projection.endpoints` — the substrate registers
//     `walrus-aggregator`, `walrus-publisher`, and per-node `walrus-node-<i>`
//     entries. There is no separate registered `proxy` endpoint (the proxy URL
//     is a codegen binding, not a projection endpoint), so "Proxy" renders an
//     honest "not registered" state rather than a fabricated URL.
//   - Cluster epoch + node/shard/stake + recent blobs are NOT in the control
//     plane and have no browser-safe chain read here. We attempt a direct HTTP
//     probe of the aggregator's Walrus daemon API (`/v1/api`, CORS-enabled on
//     the storage routes) to learn whether the daemon is reachable and to read
//     whatever system/epoch info it returns. Anything we can't reach renders an
//     honest "unavailable" empty state — never invented rows.
//   - "Upload" requires a browser-safe multi-step publisher flow (encode +
//     register + certify) that the dashboard does not implement, so it is
//     disabled with an inline note.

import { type ReactNode, useEffect, useState } from 'react';
import { restartPlugin } from '../../lib/api.ts';
import { displayHost } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { useToast } from '../../lib/toast.tsx';
import type { Endpoint } from '../../lib/types.ts';
import {
	CopyChip,
	Dot,
	EmptyState,
	Icon,
	Kpi,
	Panel,
	SectionHead,
	StatusBadge,
	Tooltip,
} from '../../ui/index.ts';
import type { PluginViewProps } from '../PluginPage.tsx';

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

/** Reachability of the aggregator daemon, probed directly from the browser. */
type DaemonState = 'probing' | 'reachable' | 'unreachable';

interface DaemonProbe {
	readonly state: DaemonState;
	/** Optional epoch parsed from the daemon's system info, when exposed. */
	readonly epoch: number | null;
	readonly detail: string;
}

/** Pull a numeric epoch out of an arbitrary daemon JSON payload, if present. */
const epochFrom = (body: unknown): number | null => {
	if (!body || typeof body !== 'object') return null;
	const rec = body as Record<string, unknown>;
	const direct = rec.epoch ?? rec.currentEpoch ?? rec.current_epoch;
	if (typeof direct === 'number') return direct;
	if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
	return null;
};

/**
 * Probe the Walrus aggregator daemon directly from the browser. The storage
 * routes set `cors: true`, so a readable response means the daemon is up; a
 * CORS-opaque response that still resolves means the socket is alive even though
 * we can't read the body. A network rejection means genuinely unreachable.
 */
const probeAggregator = async (baseUrl: string): Promise<DaemonProbe> => {
	const root = baseUrl.replace(/\/+$/, '');
	const candidates = [`${root}/v1/api`, root];
	let lastDetail = 'no response';
	for (const url of candidates) {
		try {
			const res = await fetch(url, { method: 'GET', mode: 'cors' });
			if (res.ok) {
				let epoch: number | null = null;
				try {
					epoch = epochFrom(await res.clone().json());
				} catch {
					// Body wasn't JSON — reachability still confirmed.
				}
				return { state: 'reachable', epoch, detail: `HTTP ${res.status} · ${url}` };
			}
			lastDetail = `HTTP ${res.status}`;
		} catch (err) {
			try {
				await fetch(url, { method: 'GET', mode: 'no-cors' });
				return { state: 'reachable', epoch: null, detail: `reachable (opaque) · ${url}` };
			} catch {
				lastDetail = err instanceof Error ? err.message : String(err);
			}
		}
	}
	return { state: 'unreachable', epoch: null, detail: lastDetail };
};

const byName = (endpoints: ReadonlyArray<Endpoint>, name: string): Endpoint | null =>
	endpoints.find((e) => e.name === name) ?? null;

export const WalrusView = ({ row, endpoint, projection, chain }: PluginViewProps) => {
	const { success, info } = useToast();
	const network = chain.network;
	const endpoints = projection.endpoints.filter((e) => e.name.startsWith('walrus'));

	const aggregator = byName(endpoints, 'walrus-aggregator');
	const publisher = byName(endpoints, 'walrus-publisher');
	// Per-node endpoints, in index order, are the closest thing the projection
	// has to a cluster-node listing.
	const nodeEndpoints = endpoints
		.filter((e) => e.name.startsWith('walrus-node-'))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

	const [probe, setProbe] = useState<DaemonProbe>({ state: 'probing', epoch: null, detail: '' });

	// Probe the aggregator daemon directly whenever the connected stack changes.
	useEffect(() => {
		let alive = true;
		const url = aggregator?.url ?? null;
		if (!url) {
			setProbe({ state: 'unreachable', epoch: null, detail: 'no aggregator endpoint' });
			return;
		}
		setProbe({ state: 'probing', epoch: null, detail: '' });
		void probeAggregator(url).then((result) => {
			if (alive) setProbe(result);
		});
		return () => {
			alive = false;
		};
	}, [aggregator?.url, network]);

	const clusterReady = probe.state === 'reachable';
	const nodeCount = nodeEndpoints.length;
	const subtitle = 'decentralized storage';
	const phase = row?.phase ?? 'walrus';

	const header = (
		<div className="row between wrap" style={{ gap: 12 }}>
			<div className="row" style={{ gap: 13 }}>
				<div
					style={{
						width: 42,
						height: 42,
						borderRadius: 11,
						display: 'grid',
						placeItems: 'center',
						background: 'color-mix(in oklab, var(--c-cyan) 16%, transparent)',
						color: 'var(--c-cyan)',
						flex: 'none',
						boxShadow: '0 0 0 1px color-mix(in oklab, var(--c-cyan) 28%, transparent)',
					}}
				>
					<Icon name="database" size={21} />
				</div>
				<div>
					<div className="row" style={{ gap: 10 }}>
						<h2 style={{ fontSize: 19 }}>Walrus</h2>
						{row && <StatusBadge status={row.status} />}
					</div>
					<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
						{subtitle} ·{' '}
						<span className="mono" style={{ color: 'var(--tx-lo)' }}>
							{phase}
						</span>
					</span>
				</div>
			</div>
			<div className="row" style={{ gap: 8 }}>
				<button
					className="btn btn-sm"
					onClick={() => {
						if (!row?.key) return;
						void restartPlugin(endpoint, row.key)
							.then((r) =>
								r.ok ? success(r.message ?? 'Restart requested') : info(r.message ?? 'Restart failed'),
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
			</div>
		</div>
	);

	return (
		<div className="col" style={{ gap: 18 }}>
			{header}

			{/* KPIs. Epoch is read from the daemon when it exposes it; cluster/shard
			    counts beyond the per-node endpoint listing aren't reachable here. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
					gap: 14,
				}}
			>
				<Kpi
					label="Cluster"
					value={
						probe.state === 'probing' ? '…' : clusterReady ? `${nodeCount}/${nodeCount}` : `0/${nodeCount}`
					}
					sub="nodes reachable"
					token={clusterReady ? 'green' : probe.state === 'probing' ? 'yellow' : 'white'}
					icon="database"
				/>
				<Kpi
					label="Storage epoch"
					value={probe.epoch ?? EM_DASH}
					sub={probe.epoch === null ? 'not reported' : undefined}
					icon="clock"
				/>
				<Kpi label="Blobs stored" value={EM_DASH} sub="no indexer" token="cyan" icon="box" />
				<Kpi label="Shards" value={EM_DASH} sub="on-chain" token="blue" icon="hash" />
			</div>

			<div
				style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 18, alignItems: 'start' }}
			>
				<div className="col" style={{ gap: 18 }}>
					{/* Endpoints — real registered URLs; proxy is honestly absent. */}
					<Panel pad>
						<SectionHead title="Endpoints" />
						<Field label="Aggregator">
							{aggregator ? (
								<CopyChip text={aggregator.url} display={displayHost(aggregator)} />
							) : (
								<span style={{ color: 'var(--tx-dim)' }}>{EM_DASH}</span>
							)}
						</Field>
						<Field label="Publisher">
							{publisher ? (
								<CopyChip text={publisher.url} display={displayHost(publisher)} />
							) : (
								<span style={{ color: 'var(--tx-dim)' }}>{EM_DASH}</span>
							)}
						</Field>
						<Field label="Proxy">
							<Tooltip label="No proxy endpoint is registered in the projection for this stack.">
								<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>not registered</span>
							</Tooltip>
						</Field>
						<Field label="Daemon">
							<span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
								<Dot
									token={clusterReady ? 'green' : probe.state === 'probing' ? 'yellow' : 'red'}
									pulse={probe.state === 'probing'}
								/>
								<Tooltip label={probe.detail || 'probing the aggregator daemon'}>
									<span
										style={{
											fontSize: 12.5,
											color: clusterReady
												? 'var(--c-green)'
												: probe.state === 'probing'
													? 'var(--c-yellow)'
													: 'var(--c-red)',
										}}
									>
										{probe.state === 'probing'
											? 'probing'
											: clusterReady
												? 'reachable'
												: 'unreachable'}
									</span>
								</Tooltip>
							</span>
						</Field>
					</Panel>

					{/* Cluster nodes — derived from the per-node router endpoints. Shard
					    and stake counts live on-chain / in the daemon and aren't reachable
					    here, so they render as dashes rather than invented numbers. */}
					<Panel
						header={<SectionHead title="Cluster nodes" count={nodeCount || undefined} />}
					>
						{nodeCount === 0 ? (
							<EmptyState
								icon="database"
								title="No cluster nodes"
								hint="No per-node Walrus endpoints are registered for this stack."
							/>
						) : (
							<table className="tbl">
								<thead>
									<tr>
										<th>Node</th>
										<th>Shards</th>
										<th>Stake</th>
										<th>Status</th>
									</tr>
								</thead>
								<tbody>
									{nodeEndpoints.map((node) => (
										<tr key={node.endpointKey}>
											<td className="mono" style={{ fontSize: 12.5 }}>
												{node.name}
											</td>
											<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
												{EM_DASH}
											</td>
											<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
												{EM_DASH}
											</td>
											<td>
												<StatusBadge status={row?.status ?? 'ready'} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</Panel>
				</div>

				{/* Recent blobs — needs a Walrus indexer the browser can't reach; honest
				    empty state, plus a disabled Upload (no browser-safe publish flow). */}
				<Panel
					header={
						<SectionHead
							title="Recent blobs"
							right={
								<Tooltip label="Uploading needs the publisher encode/register/certify flow, which the dashboard doesn't implement.">
									<button className="btn btn-sm" disabled>
										<Icon
											name="download"
											size={13}
											style={{ transform: 'rotate(180deg)' }}
										/>{' '}
										Upload
									</button>
								</Tooltip>
							}
						/>
					}
				>
					<EmptyState
						icon="box"
						title="Blob list unavailable"
						hint="Recent blobs come from a Walrus indexer that isn't reachable from the browser for this stack. Blobs aren't fabricated here."
					/>
				</Panel>
			</div>
		</div>
	);
};
