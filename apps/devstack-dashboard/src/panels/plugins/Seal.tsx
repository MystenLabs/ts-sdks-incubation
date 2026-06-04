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
// The 3-state browser-direct probe (`up`/`down`/`unreachable`) lives in
// `../../lib/probe.ts` — the single source of truth shared with the Walrus
// panel. See that module for the full classification rationale. This panel
// supplies a single `/health` candidate and its key-server-specific banner copy.

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { restartPlugin, type SealInfo } from '../../lib/api.ts';
import { truncateMiddle } from '../../lib/format.ts';
import {
	PROBE_TOKEN,
	type ProbeResult,
	probeBanner,
	probeDaemon,
	probeLabel,
	trimTrailingSlash,
} from '../../lib/probe.ts';
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

/** Status label per probe state — Seal renders `up` for the healthy state. */
const PROBE_LABEL = probeLabel();

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
		// Same `/health` route devstack's own readiness probe uses (returns
		// `{name, version, status: "up"}` with a 2xx on a healthy daemon).
		const result = await probeDaemon([`${trimTrailingSlash(keyServerUrl)}/health`]);
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
	// Banner content (tone + title + body) for the two banner-worthy states comes
	// from the shared `probeBanner`: `down` = a readable non-2xx /health (genuine
	// outage, red); `unreachable` = no readable response (ambiguous CORS/network,
	// soft yellow). Returns null for `up`/`probing`. The trailing ` (detail)` is
	// appended here, exactly as before.
	const banner = probeBanner(probe.state, {
		downTitle: 'Key-server is down',
		unreachableTitle: 'Key-server unreachable from the browser',
		endpointPhrase: "key-server's /health route",
		unreachableSubject: 'server',
		downConsequence: 'Encryption',
	});

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
					{/* Banner-worthy states only. `down` = the daemon answered /health
					    with a readable non-2xx status (genuine outage, red: encryption
					    will fail). `unreachable` = no readable response (ambiguous —
					    may still work in-process — so soft yellow, NOT red). Content
					    comes from the shared `probeBanner`; null for `up`/`probing`. */}
					{banner && (
						<Banner
							tone={banner.tone}
							title={banner.title}
							action={
								<button className="btn btn-sm" onClick={() => void runProbe()}>
									<Icon name="refresh" size={13} /> Probe
								</button>
							}
						>
							{banner.body}
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
