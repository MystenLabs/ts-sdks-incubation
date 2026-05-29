// Seal plugin view — the Seal key-server set + threshold-encryption surface.
//
// Real data: `fetchSealInfo(endpoint)` (control-plane GraphQL) gives the
// key-server objectId, threshold, mode, the direct key-server URL, and the
// configured key-server set (objectId + weight). Health is probed *directly*
// against the key-server URL from the browser (the control plane does not relay
// it) — CORS/connection failures degrade gracefully to "unreachable" rather
// than throwing. The handoff's Policies table has no backing field on
// `SealInfo`, so it renders an honest unavailable state instead of fabricated
// rows.

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { fetchSealInfo, restartPlugin, type SealInfo } from '../../lib/api.ts';
import { truncateMiddle } from '../../lib/format.ts';
import { useToast } from '../../lib/toast.tsx';
import {
	Badge,
	Banner,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	Panel,
	SectionHead,
} from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

/** Health states for the browser-direct key-server probe. */
type ProbeState = 'probing' | 'healthy' | 'unhealthy' | 'unreachable';

interface ProbeResult {
	readonly state: ProbeState;
	/** Short human note (HTTP status / failure reason) for the tooltip/body. */
	readonly detail: string;
}

/**
 * Probe the key-server directly from the browser. Seal's key-server exposes an
 * HTTP service-info surface; any 2xx/3xx (or even a CORS-opaque response that
 * still resolves) means the socket is up and serving. A network/CORS rejection
 * means we genuinely couldn't reach it. We probe `/v1/service` first (the
 * key-server's identity route), then fall back to the URL root.
 */
const probeKeyServer = async (baseUrl: string): Promise<ProbeResult> => {
	const root = baseUrl.replace(/\/+$/, '');
	const candidates = [`${root}/v1/service`, root];
	let lastDetail = 'no response';
	for (const url of candidates) {
		try {
			const res = await fetch(url, { method: 'GET', mode: 'cors' });
			if (res.ok) return { state: 'healthy', detail: `HTTP ${res.status} · ${url}` };
			lastDetail = `HTTP ${res.status}`;
		} catch (err) {
			// CORS-opaque or network failure. Try a no-cors reachability ping: if it
			// resolves, the socket is alive even though we can't read the body.
			try {
				await fetch(url, { method: 'GET', mode: 'no-cors' });
				return { state: 'healthy', detail: `reachable (opaque) · ${url}` };
			} catch {
				lastDetail = err instanceof Error ? err.message : String(err);
			}
		}
	}
	return { state: 'unreachable', detail: lastDetail };
};

const PROBE_TOKEN: Record<ProbeState, 'green' | 'yellow' | 'red'> = {
	probing: 'yellow',
	healthy: 'green',
	unhealthy: 'red',
	unreachable: 'yellow',
};

const PROBE_LABEL: Record<ProbeState, string> = {
	probing: 'probing',
	healthy: 'healthy',
	unhealthy: 'unhealthy',
	unreachable: 'unreachable',
};

export const SealView = ({ row, pluginKey, endpoint, refresh, chain }: PluginViewProps) => {
	const { success, error } = useToast();
	const network = chain.network;

	const [info, setInfo] = useState<SealInfo | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [probe, setProbe] = useState<ProbeResult>({ state: 'probing', detail: '' });
	const [busy, setBusy] = useState(false);

	// Load the Seal deployment info from the control plane (re-runs when the
	// endpoint or network changes — i.e. a different stack is connected).
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setLoadErr(null);
		fetchSealInfo(endpoint)
			.then((list) => {
				if (!alive) return;
				setInfo(list[0] ?? null);
			})
			.catch((err) => {
				if (!alive) return;
				setLoadErr(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [endpoint, network]);

	const keyServerUrl = info?.keyServerUrl ?? null;

	const runProbe = useCallback(async () => {
		if (!keyServerUrl) return;
		setProbe({ state: 'probing', detail: '' });
		const result = await probeKeyServer(keyServerUrl);
		setProbe(result);
	}, [keyServerUrl]);

	// Probe whenever a key-server URL becomes available.
	useEffect(() => {
		if (keyServerUrl) void runProbe();
		else setProbe({ state: 'unreachable', detail: 'no key-server URL' });
	}, [keyServerUrl, runProbe]);

	const onRestart = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		try {
			const result = await restartPlugin(endpoint, row?.key ?? pluginKey);
			if (result.ok) success(result.message ?? 'Seal restart requested');
			else error(result.message ?? 'Seal restart failed');
			await refresh();
		} catch (err) {
			error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [busy, endpoint, row, pluginKey, success, error, refresh]);

	const healthy = probe.state === 'healthy';
	const probeToken = PROBE_TOKEN[probe.state];

	return (
		<PluginScaffold label="Seal" icon="plug" row={row} subtitle="Threshold encryption · key-server set.">
			<div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
				<button className="btn btn-sm" disabled={busy} onClick={() => void onRestart()}>
					<Icon name="refresh" size={13} /> Restart
				</button>
			</div>

			{loadErr ? (
				<Banner tone="danger" title="Seal info unavailable">
					Couldn't load the Seal deployment from the control plane: {loadErr}
				</Banner>
			) : loading ? (
				<Panel pad>
					<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>Loading Seal deployment…</span>
				</Panel>
			) : !info ? (
				<Panel>
					<EmptyState
						icon="plug"
						title="No Seal deployment in this stack"
						hint="This stack doesn't run the Seal plugin, so there's no key-server set to show."
					/>
				</Panel>
			) : (
				<>
					{/* Warning banner + Probe when the key-server isn't confirmed healthy. */}
					{!healthy && (
						<Banner
							tone="warn"
							title="Key-server is not confirmed healthy"
							action={
								<button
									className="btn btn-sm"
									disabled={probe.state === 'probing'}
									onClick={() => void runProbe()}
								>
									<Icon name="refresh" size={13} /> Probe
								</button>
							}
						>
							Encryption requests will fail until the key-server reports healthy.
							{probe.detail ? ` (${probe.detail})` : ''}
						</Banner>
					)}

					<div
						style={{
							display: 'grid',
							gridTemplateColumns: '1fr 1.5fr',
							gap: 18,
							alignItems: 'start',
						}}
					>
						{/* Key-server card. */}
						<Panel pad>
							<SectionHead title="Key server" />
							<KeyValue label="Health">
								<span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
									<Dot token={probeToken} pulse={probe.state === 'probing'} />
									<span style={{ fontSize: 12.5, color: `var(--c-${probeToken})` }}>
										{PROBE_LABEL[probe.state]}
									</span>
								</span>
							</KeyValue>
							<KeyValue label="Mode">
								<Badge style={{ height: 19, fontSize: 11 }}>{info.mode}</Badge>
							</KeyValue>
							<KeyValue label="Threshold">
								<span className="mono tnum" style={{ fontSize: 12.5 }}>
									{info.threshold}
								</span>
							</KeyValue>
							<KeyValue label="Key servers">
								<span className="mono tnum">{info.keyServers.length}</span>
							</KeyValue>
							<KeyValue label="Object ID">
								<CopyChip text={info.objectId} display={truncateMiddle(info.objectId)} />
							</KeyValue>
							<KeyValue label="Key-server URL">
								<CopyChip
									text={info.keyServerUrl}
									display={info.keyServerUrl.replace(/^https?:\/\//, '')}
								/>
							</KeyValue>
						</Panel>

						{/* Key-server set table (objectId + weight). The handoff's "Policies"
						    table has no backing field on SealInfo, so we show the real
						    configured key-server set instead and note policies are
						    unavailable below. */}
						<Panel header={<SectionHead title="Key-server set" count={info.keyServers.length} />}>
							<KeyServerTable servers={info.keyServers} />
						</Panel>
					</div>

					{/* Honest note: policies aren't exposed by the control plane. */}
					<Panel pad>
						<SectionHead title="Policies" />
						<EmptyState
							icon="plug"
							title="Policies not exposed"
							hint="The control plane reports the key-server set, threshold, and mode, but not per-policy definitions. There's no backing data to render here yet."
						/>
					</Panel>
				</>
			)}
		</PluginScaffold>
	);
};

/** Local key/value row (the handoff's `PField`). Inlined per panel ownership. */
const KeyValue = ({ label, children }: { label: string; children: ReactNode }) => (
	<div
		className="row between"
		style={{ padding: '9px 0', borderBottom: '1px solid var(--line-faint)', gap: 12 }}
	>
		<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>{label}</span>
		<span style={{ textAlign: 'right', minWidth: 0 }}>{children}</span>
	</div>
);

const KeyServerTable = ({ servers }: { servers: SealInfo['keyServers'] }) => {
	const columns: ReadonlyArray<Column<SealInfo['keyServers'][number]>> = [
		{
			key: 'objectId',
			header: 'Object ID',
			render: (s) => <CopyChip text={s.objectId} display={truncateMiddle(s.objectId, 7, 4)} />,
		},
		{
			key: 'weight',
			header: 'Weight',
			align: 'right',
			width: 90,
			sortVal: (s) => s.weight,
			render: (s) => (
				<span className="mono tnum" style={{ fontSize: 12.5 }}>
					{s.weight}
				</span>
			),
		},
	];
	return (
		<DataTable
			columns={columns}
			rows={servers}
			rowKey={(s) => s.objectId}
			empty={<EmptyState title="No key servers configured" />}
		/>
	);
};
