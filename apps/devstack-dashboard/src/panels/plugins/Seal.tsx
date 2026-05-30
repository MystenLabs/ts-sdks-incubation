// Seal plugin view — the Seal key-server set + threshold-encryption surface.
//
// Real data: `fetchSealInfo(endpoint)` (control-plane GraphQL) gives the
// key-server objectId, threshold, mode, the direct key-server URL, and the
// configured key-server set (objectId + weight). Health is probed *directly*
// against the key-server URL from the browser (the control plane does not relay
// it) — CORS/connection failures degrade gracefully to "unreachable" rather
// than throwing.
//
// Health path: devstack's own readiness probe (see
// `packages/devstack/src/plugins/seal/key-server.ts`) hits `GET /health`, which
// returns `{name, version, status: "up"}` once the daemon has parsed its config
// and bound its listener. We probe the same `/health` route. The `/v1/*` routes
// (e.g. `/v1/service`) are the key-fetch API and reject a bare GET with HTTP 400
// — a 400 there means the server IS up and listening, not unhealthy. We treat
// any HTTP response (including 4xx) as "the socket is up and serving" and only
// warn on a genuine connection/CORS failure.

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { restartPlugin, type SealInfo } from '../../lib/api.ts';
import { truncateMiddle } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { useSealInfo } from '../../lib/useChain.ts';
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

/** Health states for the browser-direct key-server probe. A 2xx on `/health`
 *  (or an opaque ping that resolves when CORS blocks the read) is `healthy`; a
 *  non-2xx or a connection/CORS failure degrades to `unreachable`. */
type ProbeState = 'probing' | 'healthy' | 'unreachable';

interface ProbeResult {
	readonly state: ProbeState;
	/** Short human note (HTTP status / failure reason) for the tooltip/body. */
	readonly detail: string;
}

/**
 * Probe the key-server directly from the browser. We hit the same `/health`
 * route devstack's own readiness probe uses (returns `{name, version,
 * status: "up"}` with a 2xx on a healthy daemon).
 *
 * Healthy = a 2xx on `/health`. A non-2xx (404/502/503) is NOT healthy: a real
 * daemon answers `/health` with 2xx, so a non-2xx means a wrong URL or an
 * intermediary sitting in front of a down daemon — painting that green would
 * hide an outage. We only fall back to the opaque-reachability nuance when the
 * fetch itself *throws* (CORS-opaque or network): a no-cors ping that resolves
 * proves the socket is alive even though the browser can't read the status —
 * the in-process key server may still serve Seal in that case. A network/CORS
 * rejection on both means we genuinely couldn't reach it.
 */
const probeKeyServer = async (baseUrl: string): Promise<ProbeResult> => {
	const root = baseUrl.replace(/\/+$/, '');
	const url = `${root}/health`;
	try {
		const res = await fetch(url, { method: 'GET', mode: 'cors' });
		if (res.ok) {
			return { state: 'healthy', detail: `HTTP ${res.status} · ${url}` };
		}
		// Non-2xx on /health — a healthy daemon returns 2xx here, so this is a
		// wrong URL or a proxy in front of a down daemon. Don't paint it green.
		return { state: 'unreachable', detail: `HTTP ${res.status} on ${url} (expected 2xx)` };
	} catch (err) {
		// CORS-opaque or network failure. A no-cors ping that resolves proves the
		// socket is alive even though we can't read the status/body.
		try {
			await fetch(url, { method: 'GET', mode: 'no-cors' });
			return { state: 'healthy', detail: `reachable (opaque) · ${url}` };
		} catch {
			const detail = err instanceof Error ? err.message : String(err);
			return { state: 'unreachable', detail };
		}
	}
};

const PROBE_TOKEN: Record<ProbeState, 'green' | 'yellow' | 'red'> = {
	probing: 'yellow',
	healthy: 'green',
	unreachable: 'yellow',
};

const PROBE_LABEL: Record<ProbeState, string> = {
	probing: 'probing',
	healthy: 'healthy',
	unreachable: 'unreachable',
};

export const SealView = ({ row, pluginKey, endpoint, refresh, chain }: PluginViewProps) => {
	const { success, error } = useToast();
	const network = chain.network;

	// Seal deployment info from the control plane, re-keyed per endpoint+network.
	const sealQuery = useSealInfo(endpoint, network);
	const info: SealInfo | null = sealQuery.data?.[0] ?? null;
	const loading = sealQuery.isLoading;
	const loadErr = sealQuery.isError
		? sealQuery.error instanceof Error
			? sealQuery.error.message
			: String(sealQuery.error)
		: null;

	const [probe, setProbe] = useState<ProbeResult>({ state: 'probing', detail: '' });
	const [busy, setBusy] = useState(false);

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

	const probeToken = PROBE_TOKEN[probe.state];
	// Only the genuine connection failure is worth a banner; a reachable server
	// (any HTTP response) is healthy, and `probing` is a transient state.
	const unreachable = probe.state === 'unreachable';

	return (
		<PluginScaffold
			label="Seal"
			icon="plug"
			row={row}
			token="magenta"
			subtitle="Threshold encryption · key-server set."
			actions={
				<>
					<button className="btn btn-sm" disabled={busy} onClick={() => void onRestart()}>
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
					{/* Banner + re-probe only when the key-server is genuinely
					    unreachable (connection/CORS failure). A reachable server —
					    even one that answers a bare GET with 4xx — is healthy. */}
					{unreachable && (
						<Banner
							tone="warn"
							title="Key-server unreachable from the browser"
							action={
								<button className="btn btn-sm" onClick={() => void runProbe()}>
									<Icon name="refresh" size={13} /> Probe
								</button>
							}
						>
							Couldn't reach the key-server's /health route. This may be a CORS or network issue
							from the browser rather than the server being down — encryption requests may still
							work in-process.
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

						{/* Key-server set table (objectId + weight) — the real configured
						    set from the control plane. */}
						<Panel header={<SectionHead title="Key-server set" count={info.keyServers.length} />}>
							<KeyServerTable servers={info.keyServers} />
						</Panel>
					</div>
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
