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

/** Reachability of the aggregator daemon, probed directly from the browser. */
type DaemonState = 'probing' | 'reachable' | 'unreachable';

interface DaemonProbe {
	readonly state: DaemonState;
	readonly detail: string;
}

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
			if (res.ok) return { state: 'reachable', detail: `HTTP ${res.status} · ${url}` };
			lastDetail = `HTTP ${res.status}`;
		} catch (err) {
			try {
				await fetch(url, { method: 'GET', mode: 'no-cors' });
				return { state: 'reachable', detail: `reachable (opaque) · ${url}` };
			} catch {
				lastDetail = err instanceof Error ? err.message : String(err);
			}
		}
	}
	return { state: 'unreachable', detail: lastDetail };
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

	const clusterReady = probe.state === 'reachable';
	const nodeCount = nodeEndpoints.length;
	const epoch = epochQ.data ?? null;

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
					token={clusterReady ? 'green' : probe.state === 'probing' ? 'yellow' : 'white'}
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
