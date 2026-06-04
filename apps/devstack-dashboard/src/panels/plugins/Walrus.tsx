// Walrus plugin view. Header bar (Restart + "Logs & events"), KPIs, an
// endpoints card, a cluster-nodes table, and a recent-blobs table.
//
// Data sources & honesty:
//   - Endpoint URLs come from `projection.endpoints` — the substrate registers
//     `walrus-aggregator`, `walrus-publisher`, and per-node `walrus-node-<i>`
//     entries. There is no separate registered `proxy` endpoint (the proxy URL
//     is a codegen binding, not a projection endpoint), so "Proxy" renders an
//     honest "not registered" state rather than a fabricated URL.
//   - Storage epoch, cluster shard layout, and recent blobs are read directly
//     from the node's Sui GraphQL endpoint (browser-direct, CORS-open) — no
//     Walrus indexer is involved. `lib/walrus.ts` queries the on-chain Walrus
//     events/transactions: the storage epoch from the latest `EpochChange*`
//     event, per-node shard counts from `ShardsReceived` events, and recent
//     blobs from `register_blob`/`certify_blob` transactions (merged by blob id).
//     Anything genuinely unreachable still renders an honest empty state — never
//     invented rows.
//   - We also probe the aggregator daemon's HTTP API directly to show whether
//     the storage daemon is reachable (reachability the GraphQL reads can't tell
//     us about).
//   - "Upload" requires a browser-safe multi-step publisher flow (encode +
//     register + certify) that the dashboard does not implement, so it is
//     disabled with an inline note.

import { type ReactNode, useEffect, useState } from 'react';
import { restartPlugin } from '../../lib/api.ts';
import {
	displayHost,
	formatBytes,
	groupDigits,
	timeAgo,
	truncateMiddle,
} from '../../lib/format.ts';
import { navigate, gotoObject, gotoTx } from '../../lib/router.ts';
import { suiGraphqlUrl } from '../../lib/sui-graphql.ts';
import { useToast } from '../../lib/toast.tsx';
import type { Endpoint } from '../../lib/types.ts';
import {
	walrusPackageId,
	useRecentBlobs,
	useShardAssignments,
	useWalrusEpoch,
	type ShardAssignment,
	type WalrusSource,
} from '../../lib/walrus.ts';
import {
	Badge,
	Banner,
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
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

const EM_DASH = '—';

/** Inline-styled id/digest link button, matching the explorer's clickable ids. */
const LinkButton = ({
	onClick,
	title,
	children,
}: {
	onClick: () => void;
	title?: string;
	children: ReactNode;
}) => (
	<button
		type="button"
		onClick={onClick}
		title={title}
		style={{
			background: 'none',
			border: 'none',
			padding: 0,
			color: 'var(--c-magenta)',
			fontSize: 12.5,
			fontFamily: 'inherit',
			textAlign: 'left',
			cursor: 'pointer',
		}}
	>
		{children}
	</button>
);

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

/** Health states for the browser-direct aggregator-daemon probe.
 *  - `up`          — a probe candidate answered 2xx (green).
 *  - `down`        — a probe candidate answered a *readable* non-2xx status; the
 *                    daemon is genuinely down / a proxy fronts a dead daemon (red).
 *  - `unreachable` — no readable response (fetch threw, or an opaque CORS-hidden
 *                    response): genuinely ambiguous, may still work in-process
 *                    (yellow). */
type DaemonState = 'probing' | 'up' | 'down' | 'unreachable';

interface DaemonProbe {
	readonly state: DaemonState;
	readonly detail: string;
}

/**
 * Probe the Walrus aggregator daemon directly from the browser. We try two
 * candidates (`${root}/v1/api` then the root). The storage routes set
 * `cors: true`, so a healthy daemon answers a *readable* 2xx. Three outcomes:
 *
 *   - `up`          — a *readable* 2xx from a candidate.
 *   - `down`        — a *readable* non-2xx (404/502/503…). A response WAS received
 *                     and the browser could read its status; a healthy daemon
 *                     answers 2xx, so this is a wrong URL or — more often — a
 *                     proxy/load-balancer in front of a dead daemon. A genuine
 *                     outage we must surface in red, not soften.
 *   - `unreachable` — no readable status at all from any candidate. Either the
 *                     cross-origin `fetch` *threw* (network down / CORS preflight
 *                     rejected) and even a `no-cors` ping couldn't confirm the
 *                     socket, OR the socket answered but only as an *opaque*
 *                     (CORS-hidden) response we can't read a status from. Both are
 *                     genuinely ambiguous — the in-process aggregator may still
 *                     serve storage — so they stay a soft yellow with the "may be
 *                     CORS/network" copy.
 */
const probeAggregator = async (baseUrl: string): Promise<DaemonProbe> => {
	const root = baseUrl.replace(/\/+$/, '');
	const candidates = [`${root}/v1/api`, root];
	let lastDetail = 'no response';
	// A readable non-2xx is a genuine daemon-down signal. We remember it but keep
	// trying the next candidate (which might return 2xx); if none does, this wins
	// over the ambiguous `unreachable` fallback.
	let downDetail: string | null = null;
	for (const url of candidates) {
		try {
			const res = await fetch(url, { method: 'GET', mode: 'cors' });
			// `type: 'opaque'` means a no-cors response slipped through with a hidden
			// status (res.ok forced false, res.status forced 0) — we can't read it, so
			// treat it as the ambiguous reachable-but-unreadable case, not `down`.
			if (res.type === 'opaque') {
				lastDetail = `reachable (opaque) · ${url}`;
				continue;
			}
			if (res.ok) return { state: 'up', detail: `HTTP ${res.status} · ${url}` };
			// Readable non-2xx — a response came back and we can read its status. A
			// healthy daemon returns 2xx, so this is a down/misrouted daemon.
			downDetail = `HTTP ${res.status} on ${url} (expected 2xx)`;
			lastDetail = downDetail;
		} catch (err) {
			// The CORS-mode fetch threw (network/CORS). A `no-cors` ping that *resolves*
			// proves a socket is alive but yields an opaque, unreadable response — we
			// still can't distinguish a healthy daemon from a down one behind a proxy,
			// so it remains the ambiguous `unreachable` case, not green.
			try {
				await fetch(url, { method: 'GET', mode: 'no-cors' });
				lastDetail = `reachable (opaque) · ${url}`;
			} catch {
				lastDetail = err instanceof Error ? err.message : String(err);
			}
		}
	}
	// A readable non-2xx anywhere is a genuine outage (red); otherwise no readable
	// response at all, which is the ambiguous CORS/network case (soft yellow).
	if (downDetail !== null) return { state: 'down', detail: downDetail };
	return { state: 'unreachable', detail: lastDetail };
};

const PROBE_TOKEN: Record<DaemonState, 'green' | 'yellow' | 'red'> = {
	probing: 'yellow',
	up: 'green',
	down: 'red',
	unreachable: 'yellow',
};

const PROBE_LABEL: Record<DaemonState, string> = {
	probing: 'probing',
	up: 'reachable',
	down: 'down',
	unreachable: 'unreachable',
};

const byName = (endpoints: ReadonlyArray<Endpoint>, name: string): Endpoint | null =>
	endpoints.find((e) => e.name === name) ?? null;

/** Shards held by the node at `index`, when the shard layout is known. */
const shardsFor = (shards: ShardAssignment | null | undefined, index: number): number | null => {
	if (!shards) return null;
	return index < shards.perNode.length ? shards.perNode[index] : null;
};

export const WalrusView = ({ row, endpoint, projection, chain }: PluginViewProps) => {
	const { success, info } = useToast();
	const network = chain.network;
	const endpoints = projection.endpoints.filter((e) => e.name.startsWith('walrus'));

	const aggregator = byName(endpoints, 'walrus-aggregator');
	const publisher = byName(endpoints, 'walrus-publisher');
	// Per-node endpoints, in index order, are the projection's node listing.
	const nodeEndpoints = endpoints
		.filter((e) => e.name.startsWith('walrus-node-'))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

	// Browser-direct Walrus reads over the node's Sui GraphQL endpoint.
	const source: WalrusSource = {
		graphqlUrl: suiGraphqlUrl(projection.endpoints),
		packageId: walrusPackageId(projection.packages),
		network,
	};
	const epochQ = useWalrusEpoch(source);
	const shardsQ = useShardAssignments(source);
	const blobsQ = useRecentBlobs(source, 25);
	const shards = shardsQ.data ?? null;
	const blobs = blobsQ.data ?? [];

	const [probe, setProbe] = useState<DaemonProbe>({ state: 'probing', detail: '' });

	// Probe the aggregator daemon directly whenever the connected stack changes.
	useEffect(() => {
		let alive = true;
		const url = aggregator?.url ?? null;
		if (!url) {
			setProbe({ state: 'unreachable', detail: 'no aggregator endpoint' });
			return;
		}
		setProbe({ state: 'probing', detail: '' });
		void probeAggregator(url).then((result) => {
			if (alive) setProbe(result);
		});
		return () => {
			alive = false;
		};
	}, [aggregator?.url, network]);

	const clusterReady = probe.state === 'up';
	const probeToken = PROBE_TOKEN[probe.state];
	// Two distinct banner-worthy states. `down` = a readable non-2xx from the
	// aggregator's HTTP API: a genuine outage, surfaced in red. `unreachable` = no
	// readable response: the ambiguous CORS/network case, surfaced in soft yellow.
	// `up`/`probing` get no banner.
	const down = probe.state === 'down';
	const unreachable = probe.state === 'unreachable';
	const nodeCount = nodeEndpoints.length;
	const epoch = epochQ.data ?? null;

	// Re-probe the aggregator daemon on demand (banner action buttons).
	const runProbe = () => {
		const url = aggregator?.url ?? null;
		if (!url) {
			setProbe({ state: 'unreachable', detail: 'no aggregator endpoint' });
			return;
		}
		setProbe({ state: 'probing', detail: '' });
		void probeAggregator(url).then(setProbe);
	};

	return (
		<PluginScaffold
			label="Walrus"
			icon="database"
			row={row}
			token="cyan"
			subtitle="decentralized storage"
			phase={row?.phase ?? 'walrus'}
			actions={
				<>
					<button
						className="btn btn-sm"
						onClick={() => {
							if (!row?.key) return;
							void restartPlugin(endpoint, row.key)
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
			{/* `down` = the aggregator's HTTP API answered with a readable non-2xx
			    status — a genuine outage, surfaced in red: storage requests will
			    fail. */}
			{down && (
				<Banner
					tone="danger"
					title="Walrus aggregator is down"
					action={
						<button className="btn btn-sm" onClick={runProbe}>
							<Icon name="refresh" size={13} /> Probe
						</button>
					}
				>
					The aggregator's HTTP API returned a non-2xx status — the daemon is down (or a proxy is
					in front of a dead daemon). Storage requests will fail until it recovers.
					{probe.detail ? ` (${probe.detail})` : ''}
				</Banner>
			)}

			{/* `unreachable` = no readable response (fetch threw, or an opaque
			    CORS-hidden response). Genuinely ambiguous — may still work
			    in-process — so this stays a soft yellow, NOT red. */}
			{unreachable && (
				<Banner
					tone="warn"
					title="Aggregator unreachable from the browser"
					action={
						<button className="btn btn-sm" onClick={runProbe}>
							<Icon name="refresh" size={13} /> Probe
						</button>
					}
				>
					Couldn't read a response from the aggregator's HTTP API. This may be a CORS or network
					issue from the browser rather than the daemon being down — storage requests may still
					work in-process.
					{probe.detail ? ` (${probe.detail})` : ''}
				</Banner>
			)}

			{/* KPIs — storage epoch + shard count come from on-chain Walrus events
			    over the node's GraphQL; blobs-stored is derived from the recent-blobs
			    query (a floor: it counts blobs seen in the recent register/certify
			    window, not the all-time total). */}
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
						probe.state === 'probing'
							? '…'
							: clusterReady
								? `${nodeCount}/${nodeCount}`
								: `0/${nodeCount}`
					}
					sub="nodes reachable"
					token={probeToken}
					icon="database"
				/>
				<Kpi
					label="Storage epoch"
					value={epochQ.isPending ? '…' : (epoch?.epoch ?? EM_DASH)}
					sub={
						epoch
							? epoch.changedAtMs
								? timeAgo(epoch.changedAtMs)
								: undefined
							: epochQ.isPending
								? undefined
								: 'no epoch events'
					}
					icon="clock"
				/>
				<Kpi
					label="Blobs stored"
					value={blobsQ.isPending ? '…' : groupDigits(blobs.length)}
					sub={blobs.length > 0 ? 'recent window' : blobsQ.isPending ? undefined : 'none seen'}
					token="cyan"
					icon="box"
				/>
				<Kpi
					label="Shards"
					value={shardsQ.isPending ? '…' : (shards?.totalShards ?? EM_DASH)}
					sub={shards ? `${shards.nodeCount} nodes` : shardsQ.isPending ? undefined : 'on-chain'}
					token="blue"
					icon="hash"
				/>
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
								<Dot token={probeToken} pulse={probe.state === 'probing'} />
								<Tooltip label={probe.detail || 'probing the aggregator daemon'}>
									<span style={{ fontSize: 12.5, color: `var(--c-${probeToken})` }}>
										{PROBE_LABEL[probe.state]}
									</span>
								</Tooltip>
							</span>
						</Field>
					</Panel>

					{/* Cluster nodes — the per-node router endpoints, enriched with the
					    real per-node shard counts read from the chain's `ShardsReceived`
					    events (by node index). Stake isn't exposed by those events and
					    has no browser-safe read here, so it stays an honest dash. */}
					<Panel header={<SectionHead title="Cluster nodes" count={nodeCount || undefined} />}>
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
									{nodeEndpoints.map((node, i) => {
										const nodeShards = shardsFor(shards, i);
										return (
											<tr key={node.endpointKey}>
												<td className="mono" style={{ fontSize: 12.5 }}>
													{node.name}
												</td>
												<td
													className="mono tnum"
													style={{
														color: nodeShards === null ? 'var(--tx-dim)' : 'var(--tx-hi)',
													}}
												>
													{nodeShards === null ? EM_DASH : nodeShards}
												</td>
												<td className="mono tnum" style={{ color: 'var(--tx-dim)' }}>
													{EM_DASH}
												</td>
												<td>
													<StatusBadge status={row?.status ?? 'ready'} />
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
					</Panel>
				</div>

				{/* Recent blobs — register/certify transactions on the node's Sui
				    GraphQL, merged by blob id. Upload stays disabled (no browser-safe
				    publish flow). */}
				<Panel
					header={
						<SectionHead
							title="Recent blobs"
							count={blobs.length || undefined}
							right={
								<Tooltip label="Uploading needs the publisher encode/register/certify flow, which the dashboard doesn't implement.">
									<button className="btn btn-sm" disabled>
										<Icon name="download" size={13} style={{ transform: 'rotate(180deg)' }} />{' '}
										Upload
									</button>
								</Tooltip>
							}
						/>
					}
				>
					{blobsQ.isError ? (
						<EmptyState
							icon="box"
							title="Blob list unavailable"
							hint={
								source.graphqlUrl === null
									? 'No Sui GraphQL endpoint is registered for this stack.'
									: source.packageId === null
										? 'No Walrus package was found in the projection for this stack.'
										: `GraphQL read failed: ${
												blobsQ.error instanceof Error ? blobsQ.error.message : 'unknown error'
											}`
							}
						/>
					) : blobsQ.isPending ? (
						<EmptyState
							icon="box"
							title="Loading recent blobs…"
							hint="Querying the node's Sui GraphQL."
						/>
					) : blobs.length === 0 ? (
						<EmptyState
							icon="box"
							title="No recent blobs"
							hint="No register_blob / certify_blob transactions were found on-chain for this stack yet."
						/>
					) : (
						<table className="tbl">
							<thead>
								<tr>
									<th>Blob</th>
									<th>Size</th>
									<th>Epochs</th>
									<th>When</th>
									<th>State</th>
								</tr>
							</thead>
							<tbody>
								{blobs.map((b) => (
									<tr key={b.blobId}>
										<td className="mono" style={{ fontSize: 12.5 }}>
											{b.objectId ? (
												<LinkButton
													onClick={() => gotoObject(b.objectId as string)}
													title={`blob_id ${b.blobId}`}
												>
													{truncateMiddle(b.objectId)}
												</LinkButton>
											) : (
												<span title={`blob_id ${b.blobId}`}>{truncateMiddle(b.blobId)}</span>
											)}
										</td>
										<td className="mono tnum" style={{ color: 'var(--tx-mid)' }}>
											{b.size === null ? EM_DASH : formatBytes(b.size)}
										</td>
										<td className="mono tnum" style={{ color: 'var(--tx-mid)' }}>
											{b.registeredEpoch !== null && b.endEpoch !== null
												? `${b.registeredEpoch} → ${b.endEpoch}`
												: b.endEpoch !== null
													? `→ ${b.endEpoch}`
													: EM_DASH}
										</td>
										<td style={{ color: 'var(--tx-mid)', fontSize: 12.5 }}>
											{b.digest ? (
												<LinkButton onClick={() => gotoTx(b.digest as string)} title={b.digest}>
													{b.timestampMs ? timeAgo(b.timestampMs) : 'tx'}
												</LinkButton>
											) : b.timestampMs ? (
												timeAgo(b.timestampMs)
											) : (
												EM_DASH
											)}
										</td>
										<td>
											{b.certified ? (
												<Badge style={{ height: 18, fontSize: 10, color: 'var(--c-green)' }}>
													certified
												</Badge>
											) : (
												<Badge style={{ height: 18, fontSize: 10, color: 'var(--c-yellow)' }}>
													registered
												</Badge>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</div>
		</PluginScaffold>
	);
};
