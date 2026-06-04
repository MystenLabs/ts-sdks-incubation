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
// and bound its listener. We probe the same `/health` route.
//
// Three distinct probe outcomes drive the dot + banner:
//   - `up`          — `/health` answered 2xx. Green, no banner.
//   - `down`        — `/health` answered with a *readable* non-2xx status
//                     (e.g. 502/503 from a proxy in front of a dead daemon, or a
//                     404 from a wrong URL). A response WAS received and the
//                     browser could read it, so this is a genuine outage, not an
//                     ambiguity. Red, "encryption will fail" banner.
//   - `unreachable` — no readable response at all: the cross-origin `fetch`
//                     threw (network/CORS) and even a `no-cors` ping couldn't
//                     prove the socket alive, OR the socket answered but only as
//                     an opaque (CORS-hidden) response we can't read a status
//                     from. This is genuinely ambiguous — the in-process key
//                     server may still serve Seal — so it stays a soft yellow.

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

/** Health states for the browser-direct key-server probe.
 *  - `up`          — `/health` answered 2xx (green).
 *  - `down`        — `/health` answered a *readable* non-2xx status; the daemon
 *                    is genuinely down / misrouted (red).
 *  - `unreachable` — no readable response (fetch threw, or an opaque CORS-hidden
 *                    response): genuinely ambiguous, may still work in-process
 *                    (yellow). */
type ProbeState = 'probing' | 'up' | 'down' | 'unreachable';

interface ProbeResult {
	readonly state: ProbeState;
	/** Short human note (HTTP status / failure reason) for the tooltip/body. */
	readonly detail: string;
}

/**
 * Probe the key-server directly from the browser. We hit the same `/health`
 * route devstack's own readiness probe uses (returns `{name, version,
 * status: "up"}` with a 2xx on a healthy daemon). Three outcomes:
 *
 *   - `up`          — a *readable* 2xx on `/health`.
 *   - `down`        — a *readable* non-2xx on `/health` (404/502/503…). A real
 *                     daemon answers `/health` with 2xx, so a readable non-2xx
 *                     means a wrong URL or — more often — a proxy/load-balancer
 *                     in front of a dead daemon. A response WAS received and the
 *                     browser could read its status, so this is a genuine outage
 *                     we must surface in red, not soften.
 *   - `unreachable` — no readable status at all. Either the cross-origin `fetch`
 *                     *threw* (network down / CORS preflight rejected) and even a
 *                     `no-cors` ping couldn't confirm the socket, OR the socket
 *                     answered but only as an *opaque* (CORS-hidden) response we
 *                     can't read a status from. Both are genuinely ambiguous —
 *                     the in-process key server may still serve Seal — so they
 *                     stay a soft yellow with the "may be CORS/network" copy.
 */
const probeKeyServer = async (baseUrl: string): Promise<ProbeResult> => {
	const root = baseUrl.replace(/\/+$/, '');
	const url = `${root}/health`;
	try {
		const res = await fetch(url, { method: 'GET', mode: 'cors' });
		// `type: 'opaque'` means a no-cors response slipped through with a hidden
		// status (res.ok is forced false, res.status forced 0) — we can't read it,
		// so treat it as the ambiguous reachable-but-unreadable case, not `down`.
		if (res.type === 'opaque') {
			return { state: 'unreachable', detail: `reachable (opaque) · ${url}` };
		}
		if (res.ok) {
			return { state: 'up', detail: `HTTP ${res.status} · ${url}` };
		}
		// Readable non-2xx on /health — a response came back and we can read its
		// status. A healthy daemon returns 2xx, so this is a down/misrouted daemon.
		return { state: 'down', detail: `HTTP ${res.status} on ${url} (expected 2xx)` };
	} catch (err) {
		// The CORS-mode fetch threw (network/CORS). A `no-cors` ping that *resolves*
		// proves a socket is alive but yields an opaque, unreadable response — we
		// still can't distinguish a healthy daemon from a down one behind a proxy,
		// so it remains the ambiguous `unreachable` case, not green.
		try {
			await fetch(url, { method: 'GET', mode: 'no-cors' });
			return { state: 'unreachable', detail: `reachable (opaque) · ${url}` };
		} catch {
			const detail = err instanceof Error ? err.message : String(err);
			return { state: 'unreachable', detail };
		}
	}
};

const PROBE_TOKEN: Record<ProbeState, 'green' | 'yellow' | 'red'> = {
	probing: 'yellow',
	up: 'green',
	down: 'red',
	unreachable: 'yellow',
};

const PROBE_LABEL: Record<ProbeState, string> = {
	probing: 'probing',
	up: 'up',
	down: 'down',
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
	// Two distinct banner-worthy states. `down` = a readable non-2xx /health: a
	// genuine outage, surfaced in red. `unreachable` = no readable response: the
	// ambiguous CORS/network case, surfaced in soft yellow. `up`/`probing` get no
	// banner.
	const down = probe.state === 'down';
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
					{/* `down` = the daemon answered /health with a readable non-2xx
					    status — a genuine outage, surfaced in red: encryption will
					    fail. */}
					{down && (
						<Banner
							tone="danger"
							title="Key-server is down"
							action={
								<button className="btn btn-sm" onClick={() => void runProbe()}>
									<Icon name="refresh" size={13} /> Probe
								</button>
							}
						>
							The key-server's /health route returned a non-2xx status — the daemon is down (or a
							proxy is in front of a dead daemon). Encryption requests will fail until it
							recovers.
							{probe.detail ? ` (${probe.detail})` : ''}
						</Banner>
					)}

					{/* `unreachable` = no readable response (fetch threw, or an opaque
					    CORS-hidden response). Genuinely ambiguous — may still work
					    in-process — so this stays a soft yellow, NOT red. */}
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
							Couldn't read a response from the key-server's /health route. This may be a CORS or
							network issue from the browser rather than the server being down — encryption
							requests may still work in-process.
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
