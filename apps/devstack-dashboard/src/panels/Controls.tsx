// Controls & Operations panel — the engine-command surface.
//
// Full port of the design handoff's Controls screen, wired to the real
// control-plane API. The command grid exposes every backed mutation: Restart,
// Apply, Codegen, Prune, Advance clock (only shown when `mode === 'fork'`), Wipe
// and Shutdown. Benign commands dispatch directly; destructive ones (Wipe,
// Prune, Restart stack) route through a red `ConfirmDialog` and a "destructive"
// badge, while Shutdown takes a plain (non-red) confirm — it loses the dashboard
// connection but no state. Each action toasts its `CommandResult` and forces a
// projection refresh; a whole-grid `busy` lock disables the grid while a command
// is in flight.
//
// "Selective restart" lists a chip per managed row, each gated behind its own
// confirm → `restartPlugin`.
//
// "Snapshots" panel captures (naming dialog) and renders the real snapshot
// catalog from `fetchSnapshots` with Restore / delete (both confirmed) →
// `restoreSnapshot` / `deleteSnapshot`.
//
// Capture completion is REAL, not instant. `captureSnapshot` goes through the
// supervisor's command queue (fire-and-forget) because capture must register
// in the supervisor's `snapshotCaptureTask` interrupt-handle so a concurrent
// shutdown/restart can interrupt it mid-`pauseAndCommit` — coordination a
// direct domain call would bypass. So the mutation only ACKs "capture started";
// the engine's capture-progress events are engine-internal and carry no
// projection slice (they never reach the dashboard). The ONLY real completion
// signal the dashboard can observe is the new artifact appearing in the
// snapshot catalog. We therefore drive a `capturing → done/failed` state
// machine off `fetchSnapshots`: enter `capturing` on a successful ack, poll the
// catalog, resolve to success when an entry with the captured label appears, or
// to failure on a timeout / non-ok ack.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
	type CommandResult,
	advanceClock,
	applyStack,
	captureSnapshot,
	deleteSnapshot,
	fetchMode,
	fetchSnapshots,
	pruneStack,
	restartPlugin,
	restartStack,
	restoreSnapshot,
	runCodegen,
	type SnapshotEntry,
	shutdownStack,
	wipeStack,
} from '../lib/api.ts';
import { labelForRow, statusDisplay } from '../lib/derive.ts';
import { timeAgo } from '../lib/format.ts';
import { useToast } from '../lib/toast.tsx';
import type { Row } from '../lib/types.ts';
import {
	Badge,
	Button,
	ConfirmDialog,
	type Column,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	type IconName,
	IconButton,
	Input,
	NumberInput,
	Panel,
	SectionHead,
	type StatusToken,
} from '../ui/index.ts';
import type { PanelProps } from './types.ts';

// Poll the resolved stack mode + snapshot catalog. Mode changes rarely (only on
// reconfigure), snapshots change on capture/restore/delete — keep both fresh
// enough that the grid gate + table reflect reality without hammering.
const MODE_POLL_MS = 10_000;
const SNAPSHOT_POLL_MS = 5_000;
// While a capture is in flight we poll the catalog faster (the new artifact is
// the only real completion signal) and give up after the timeout. Captures of a
// large stack can take a while — pausing containers, committing writable layers,
// saving images, taring host trees — so the ceiling is generous.
const CAPTURE_POLL_MS = 1_500;
const CAPTURE_TIMEOUT_MS = 180_000;

/** A single command tile in the grid. */
interface Command {
	readonly id: string;
	readonly label: string;
	readonly icon: IconName;
	readonly desc: string;
	readonly token: StatusToken;
	/** Destructive: gate behind a red ConfirmDialog and badge the tile. */
	readonly danger?: boolean;
	/** Non-destructive but still gated behind a plain (non-red) ConfirmDialog. */
	readonly confirm?: boolean;
	/** Confirm body shown in the dialog (defaults to a generic prompt). */
	readonly confirmBody?: string;
	/** Run via the snapshot naming dialog instead of dispatching directly. */
	readonly naming?: boolean;
	/** Run via the advance-clock dialog (target millis) instead of dispatching. */
	readonly clock?: boolean;
	/** Execute the underlying mutation; the caller handles toast + refresh. */
	readonly run?: (endpoint: string) => Promise<CommandResult>;
}

const COMMANDS: ReadonlyArray<Command> = [
	{
		id: 'restart',
		label: 'Restart stack',
		icon: 'refresh',
		desc: 'Cycle all services, keep state',
		token: 'yellow',
		danger: true,
		confirmBody:
			'Cycle every service in the stack. State is preserved, but in-flight work is interrupted.',
		run: (endpoint) => restartStack(endpoint),
	},
	{
		id: 'apply',
		label: 'Apply',
		icon: 'zap',
		desc: 'Reconcile config → running stack',
		token: 'cyan',
		run: (endpoint) => applyStack(endpoint),
	},
	{
		id: 'codegen',
		label: 'Codegen',
		icon: 'hash',
		desc: 'Regenerate typed bindings',
		token: 'blue',
		run: (endpoint) => runCodegen(endpoint),
	},
	{
		id: 'prune',
		label: 'Prune',
		icon: 'filter',
		desc: 'Drop dangling containers & volumes',
		token: 'yellow',
		danger: true,
		confirmBody:
			'Remove dangling containers and volumes left behind by previous cycles. Running services are untouched.',
		run: (endpoint) => pruneStack(endpoint),
	},
	{
		id: 'advance-clock',
		label: 'Advance clock',
		icon: 'clock',
		desc: 'Fast-forward chain time',
		token: 'blue',
		clock: true,
	},
	{
		id: 'wipe',
		label: 'Wipe',
		icon: 'trash',
		desc: 'Destroy all state — genesis reset',
		token: 'red',
		danger: true,
		confirmBody:
			'Destroy all chain and container state and reset to genesis. Every account, package, and snapshot-less change is lost. This cannot be undone.',
		run: (endpoint) => wipeStack(endpoint),
	},
	{
		id: 'shutdown',
		label: 'Shutdown',
		icon: 'power',
		desc: 'Graceful stop of the whole stack',
		token: 'yellow',
		confirm: true,
		confirmBody:
			'Gracefully stop every service in the stack. No state is lost, but the dashboard will lose its connection once the engine exits.',
		run: (endpoint) => shutdownStack(endpoint),
	},
];

export const ControlsPanel = ({ projection, endpoint, refresh }: PanelProps) => {
	const toast = useToast();
	// id of the in-flight command (whole-grid lock), or null.
	const [busy, setBusy] = useState<string | null>(null);
	// Command awaiting confirmation, or null.
	const [confirm, setConfirm] = useState<Command | null>(null);
	// Managed row pending selective-restart confirmation, or null.
	const [restartRow, setRestartRow] = useState<Row | null>(null);
	// Snapshot pending restore/delete confirmation, or null.
	const [snapAction, setSnapAction] = useState<{
		readonly kind: 'restore' | 'delete';
		readonly snap: SnapshotEntry;
	} | null>(null);
	// Proposed snapshot name while the naming dialog is open, or null.
	const [naming, setNaming] = useState<string | null>(null);
	// Target epoch-millis while the advance-clock dialog is open, or null.
	const [clockTarget, setClockTarget] = useState<number | null>(null);
	// In-flight capture, tracked to REAL completion off the snapshot catalog.
	// `null` when idle. The fire-and-forget mutation only acks "capture
	// started"; we resolve to done/failed when the artifact appears (or times
	// out). `startedAt` drives the timeout; `label` is matched against catalog
	// entries (the supervisor normalizes/echoes the label, so we match the
	// trimmed name we sent). `knownIds` is the catalog snapshot at start-of-
	// capture so a NEW entry — not a pre-existing same-label one — counts.
	const [capture, setCapture] = useState<{
		readonly label: string;
		readonly startedAt: number;
		readonly knownIds: ReadonlySet<string>;
	} | null>(null);
	// In-flight restore. Unlike capture, `restoreSnapshot` is a REAL domain
	// action — the mutation AWAITS the restore and returns a real `{ok, detail}`,
	// so the true progress is simply "the mutation is in flight". We surface a
	// "Restoring <label>…" banner + indeterminate bar for that whole duration and
	// toast the real result on completion. `label` drives the banner copy;
	// `startedAt` drives the elapsed readout.
	const [restoring, setRestoring] = useState<{
		readonly label: string;
		readonly startedAt: number;
	} | null>(null);

	// Resolved stack mode gates the advance-clock command (fork-only).
	const modeQuery = useQuery({
		queryKey: ['mode', endpoint],
		queryFn: () => fetchMode(endpoint),
		refetchInterval: MODE_POLL_MS,
	});
	const isFork = modeQuery.data === 'fork';

	// Real snapshot catalog. While a capture is in flight we poll faster — the
	// catalog is the only signal that tells us the capture actually finished.
	const snapshotsQuery = useQuery({
		queryKey: ['snapshots', endpoint],
		queryFn: () => fetchSnapshots(endpoint),
		refetchInterval: capture !== null ? CAPTURE_POLL_MS : SNAPSHOT_POLL_MS,
	});
	const snapshots = snapshotsQuery.data ?? [];

	const dispatch = async (
		id: string,
		label: string,
		run: () => Promise<CommandResult>,
	): Promise<void> => {
		setBusy(id);
		try {
			const result = await run();
			if (result.ok) toast.success(result.message ?? `${label} complete`);
			else toast.error(result.message ?? `${label} failed`);
			await refresh();
			await snapshotsQuery.refetch();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : `${label} failed`);
		} finally {
			setBusy(null);
		}
	};

	const onCard = (cmd: Command): void => {
		if (busy) return;
		if (cmd.naming) setNaming(`snapshot-${Date.now()}`);
		else if (cmd.clock) setClockTarget(Date.now());
		else if (cmd.danger || cmd.confirm) setConfirm(cmd);
		else if (cmd.run) void dispatch(cmd.id, cmd.label, () => cmd.run!(endpoint));
	};

	const onRestartRow = (): void => {
		const row = restartRow;
		setRestartRow(null);
		if (!row) return;
		void dispatch(`restart/${row.key}`, `Restart ${labelForRow(row.key)}`, () =>
			restartPlugin(endpoint, row.key),
		);
	};

	const onCapture = (rawName: string): void => {
		const label = rawName.trim();
		setNaming(null);
		if (!label || capture !== null) return;
		// Fire the command. A successful result means "capture STARTED" (the
		// supervisor queued it), NOT "capture done" — so we don't toast success
		// here. We snapshot the current catalog ids, then hand off to the
		// catalog-watching effect below, which resolves to done/failed for real.
		setBusy('capture');
		void (async () => {
			try {
				const result = await captureSnapshot(endpoint, label);
				if (!result.ok) {
					toast.error(result.message ?? 'Capture snapshot failed');
					setBusy(null);
					return;
				}
				toast.info(`Capturing "${label}"…`);
				setCapture({
					label,
					startedAt: Date.now(),
					knownIds: new Set(snapshots.map((s) => s.id)),
				});
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Capture snapshot failed');
				setBusy(null);
			}
		})();
	};

	const onAdvanceClock = (toMillis: number): void => {
		setClockTarget(null);
		void dispatch('advance-clock', 'Advance clock', () => advanceClock(endpoint, toMillis));
	};

	const onSnapshotAction = async (): Promise<void> => {
		const action = snapAction;
		setSnapAction(null);
		if (!action) return;
		const { kind, snap } = action;
		const label = snap.label || snap.id;
		setBusy(`snapshot/${kind}`);
		// Restore awaits a REAL mutation — surface an in-flight banner for the
		// whole duration so the UI isn't silent while the stack is rolled back.
		if (kind === 'restore') setRestoring({ label, startedAt: Date.now() });
		try {
			const result =
				kind === 'restore'
					? await restoreSnapshot(endpoint, snap.id)
					: await deleteSnapshot(endpoint, snap.id);
			if (result.ok)
				toast.success(
					result.detail ?? `Snapshot "${label}" ${kind === 'restore' ? 'restored' : 'deleted'}`,
				);
			else toast.error(result.detail ?? `Snapshot ${kind} failed`);
			await snapshotsQuery.refetch();
			if (kind === 'restore') await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : `Snapshot ${kind} failed`);
		} finally {
			setRestoring(null);
			setBusy(null);
		}
	};

	// Resolve an in-flight capture against REAL state. The capture-progress
	// engine events never reach the dashboard (engine-internal, no projection
	// slice), so the snapshot catalog is the source of truth: a NEW entry
	// (not in `knownIds`) whose label matches what we sent means the capture
	// landed. If no such entry appears before the timeout, surface a failure —
	// the capture errored or was interrupted (e.g. by a concurrent shutdown).
	// The `refresh`/toast surface is read through a ref so this effect depends
	// only on the data it actually watches.
	const captureSideRef = useRef({ toast, refresh });
	captureSideRef.current = { toast, refresh };
	useEffect(() => {
		if (capture === null) return;
		const landed = snapshots.find(
			(s) => !capture.knownIds.has(s.id) && (s.label ?? '') === capture.label,
		);
		if (landed) {
			captureSideRef.current.toast.success(`Snapshot "${capture.label}" captured`);
			setCapture(null);
			setBusy(null);
			void captureSideRef.current.refresh();
			return;
		}
		if (Date.now() - capture.startedAt >= CAPTURE_TIMEOUT_MS) {
			captureSideRef.current.toast.error(
				`Capture "${capture.label}" did not complete — it may have failed or been interrupted.`,
			);
			setCapture(null);
			setBusy(null);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- snapshots is intentionally watched; side effects go through captureSideRef
	}, [capture, snapshots]);

	// Hard timeout. React-query's structural sharing can hand back the SAME
	// catalog array when nothing changed, so the catalog effect above may not
	// re-run to observe the deadline. This dedicated timer guarantees an
	// in-flight capture resolves to a failure if the artifact never appears.
	useEffect(() => {
		if (capture === null) return;
		const remaining = Math.max(0, capture.startedAt + CAPTURE_TIMEOUT_MS - Date.now());
		const timer = setTimeout(() => {
			captureSideRef.current.toast.error(
				`Capture "${capture.label}" did not complete — it may have failed or been interrupted.`,
			);
			setCapture(null);
			setBusy(null);
		}, remaining);
		return () => clearTimeout(timer);
	}, [capture]);

	// Live elapsed ticker. The capture/restore banners read `Date.now() -
	// startedAt`, which otherwise only recomputes when the component re-renders
	// for another reason (the ~15s catalog poll) — so the readout jumps 2s→17s.
	// A 1s tick while either is in flight makes the elapsed time count live.
	const [, setTick] = useState(0);
	useEffect(() => {
		if (capture === null && restoring === null) return;
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, [capture, restoring]);

	// Snapshot catalog table columns.
	const snapColumns: ReadonlyArray<Column<SnapshotEntry>> = [
		{
			key: 'label',
			header: 'Label',
			render: (s) => (
				<div className="col" style={{ gap: 2 }}>
					<span style={{ fontWeight: 530 }}>
						{s.label || 'snapshot'}
						{s.corrupt && (
							<Badge style={{ height: 16, fontSize: 9.5, marginLeft: 6, color: 'var(--c-red)' }}>
								corrupt
							</Badge>
						)}
					</span>
					<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)' }}>
						{s.id}
					</span>
				</div>
			),
			sortVal: (s) => s.label || s.id,
		},
		{
			key: 'created',
			header: 'Created',
			render: (s) => (
				<span style={{ color: 'var(--tx-mid)', fontSize: 12.5 }}>
					{s.createdAt ? `${timeAgo(s.createdAt)} ago` : '—'}
				</span>
			),
			sortVal: (s) => s.createdAt ?? 0,
		},
		{
			key: 'participants',
			header: 'Participants',
			align: 'right',
			render: (s) => <span className="mono tnum">{s.participants.length}</span>,
			sortVal: (s) => s.participants.length,
		},
		{
			key: 'graphInput',
			header: 'Inputs',
			render: (s) => {
				const stale = s.graphInputStatus === 'stale';
				const unknown = s.graphInputStatus === 'unknown';
				return (
					<Badge
						style={{
							color: stale ? 'var(--c-amber)' : unknown ? 'var(--tx-dim)' : 'var(--c-green)',
						}}
					>
						{stale ? 'stale' : unknown ? 'unknown' : 'current'}
					</Badge>
				);
			},
			sortVal: (s) => s.graphInputStatus,
		},
		{
			key: 'containers',
			header: 'Containers',
			align: 'right',
			render: (s) => <span className="mono tnum">{s.containerCount}</span>,
			sortVal: (s) => s.containerCount,
		},
		{
			key: 'hostTree',
			header: 'Host tree',
			render: (s) =>
				s.subtreeCount > 0 ? (
					<span className="row" style={{ gap: 6 }}>
						<Dot token="green" />
						<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
							{s.subtreeCount}
						</span>
					</span>
				) : (
					<span style={{ color: 'var(--tx-dim)' }}>—</span>
				),
			sortVal: (s) => s.subtreeCount,
		},
		{
			key: 'network',
			header: 'Network',
			render: (s) => (
				<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
					{s.network}
				</span>
			),
		},
		{
			key: 'actions',
			header: '',
			align: 'right',
			render: (s) => (
				<div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
					<Button
						sm
						disabled={busy !== null || s.corrupt}
						onClick={() => setSnapAction({ kind: 'restore', snap: s })}
					>
						Restore
					</Button>
					<IconButton
						icon="trash"
						label={`Delete snapshot ${s.label || s.id}`}
						disabled={busy !== null}
						onClick={() => setSnapAction({ kind: 'delete', snap: s })}
					/>
				</div>
			),
		},
	];

	return (
		<div className="col" style={{ gap: 22 }}>
			<div>
				<h2 style={{ fontSize: 19 }}>Controls &amp; Operations</h2>
				<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
					Engine commands dispatched in-process. The UI waits for the projection to reflect the
					effect.
				</p>
			</div>

			{/* command grid */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
					gap: 14,
				}}
			>
				{COMMANDS
					// Advance-clock only makes sense against a forked chain — omit the card
					// entirely off-fork rather than rendering it disabled.
					.filter((cmd) => !cmd.clock || isFork)
					.map((cmd) => {
						const active = busy === cmd.id;
						const disabled = busy !== null;
						return (
							<button
								key={cmd.id}
								className="panel panel-pad"
								disabled={disabled}
								onClick={() => onCard(cmd)}
								style={{
									textAlign: 'left',
									cursor: disabled ? 'not-allowed' : 'pointer',
									opacity: disabled && !active ? 0.5 : 1,
									transition: '.14s',
									display: 'flex',
									flexDirection: 'column',
									gap: 8,
								}}
							>
								<div className="row between">
									<div
										style={{
											width: 34,
											height: 34,
											borderRadius: 9,
											display: 'grid',
											placeItems: 'center',
											background: `color-mix(in oklab, var(--c-${cmd.token}) 13%, transparent)`,
											color: `var(--c-${cmd.token})`,
										}}
									>
										<Icon name={active ? 'refresh' : cmd.icon} size={17} />
									</div>
									{cmd.danger ? (
										<Badge style={{ height: 18, fontSize: 10, color: 'var(--c-red)' }}>
											destructive
										</Badge>
									) : (
										active && <span className="dot dot-cyan dot-pulse" />
									)}
								</div>
								<div style={{ fontWeight: 560, fontSize: 14 }}>{cmd.label}</div>
								<div style={{ color: 'var(--tx-lo)', fontSize: 12.5 }}>{cmd.desc}</div>
							</button>
						);
					})}
			</div>

			{/* selective restart */}
			<div className="panel panel-pad">
				<SectionHead title="Selective restart" count={projection.rows.length} />
				{projection.rows.length === 0 ? (
					<EmptyState
						icon="layers"
						title="No managed rows"
						hint="The supervisor isn't managing anything yet."
					/>
				) : (
					<div className="row wrap" style={{ gap: 8 }}>
						{projection.rows.map((row) => {
							const display = statusDisplay(row.status);
							return (
								<Button
									key={row.key}
									sm
									disabled={busy !== null}
									onClick={() => setRestartRow(row)}
								>
									<Dot token={display.token} pulse={display.pulse} /> {labelForRow(row.key)}
								</Button>
							);
						})}
					</div>
				)}
			</div>

			{/* snapshots — capture control, live progress, real catalog */}
			<Panel style={{ overflow: 'hidden' }}>
				<div className="panel-pad" style={{ paddingBottom: 12 }}>
					<SectionHead
						title="Snapshots"
						count={snapshots.length}
						right={
							<Button
								variant="primary"
								sm
								icon="camera"
								disabled={busy !== null}
								onClick={() => setNaming(`snapshot-${Date.now()}`)}
							>
								Capture
							</Button>
						}
					/>
					{capture && (
						<div
							className="panel panel-pad fade-up"
							style={{ background: 'var(--bg-elev)', marginTop: 12 }}
						>
							<div className="row between" style={{ marginBottom: 8 }}>
								<span className="row" style={{ gap: 8 }}>
									<span className="dot dot-blue dot-pulse" />
									<span style={{ fontSize: 13 }}>
										Capturing <span className="mono">"{capture.label}"</span>…
									</span>
								</span>
								<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
									{timeAgo(capture.startedAt)}
								</span>
							</div>
							{/* No granular phase/percent reaches the dashboard (the engine's
							    capture-progress events carry no projection slice), so this is
							    an indeterminate bar — it resolves when the artifact lands in
							    the catalog or the capture times out. */}
							<IndeterminateMeter token="blue" />
							<span
								style={{ fontSize: 11.5, color: 'var(--tx-dim)', marginTop: 6, display: 'block' }}
							>
								Pausing containers, committing layers and saving images — this can take a moment.
							</span>
						</div>
					)}
					{restoring && (
						<div
							className="panel panel-pad fade-up"
							style={{ background: 'var(--bg-elev)', marginTop: 12 }}
						>
							<div className="row between" style={{ marginBottom: 8 }}>
								<span className="row" style={{ gap: 8 }}>
									<span className="dot dot-blue dot-pulse" />
									<span style={{ fontSize: 13 }}>
										Restoring <span className="mono">"{restoring.label}"</span>…
									</span>
								</span>
								<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
									{timeAgo(restoring.startedAt)}
								</span>
							</div>
							{/* `restoreSnapshot` awaits the real restore, but the mutation
							    exposes no intermediate phase/percent — so, like capture, this
							    is an honest indeterminate bar for the whole in-flight duration. */}
							<IndeterminateMeter token="blue" />
							<span
								style={{ fontSize: 11.5, color: 'var(--tx-dim)', marginTop: 6, display: 'block' }}
							>
								Rolling the chain and containers back to this checkpoint — the stack is briefly
								unavailable.
							</span>
						</div>
					)}
				</div>
				{snapshots.length === 0 ? (
					<div className="panel-pad" style={{ paddingTop: 0 }}>
						<EmptyState
							icon="camera"
							title="No snapshots yet"
							hint="Capture a checkpoint of the whole stack to restore it later."
						/>
					</div>
				) : (
					<DataTable columns={snapColumns} rows={snapshots} rowKey={(s) => s.id} />
				)}
			</Panel>

			{/* command confirm — `danger` only for destructive commands (Wipe/Prune) */}
			<ConfirmDialog
				open={confirm !== null}
				danger={confirm?.danger ?? false}
				title={confirm?.label ?? ''}
				body={confirm?.confirmBody ?? `Run "${confirm?.label}"? This affects the running stack.`}
				confirmLabel={confirm?.label}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					const cmd = confirm;
					setConfirm(null);
					if (cmd?.run) void dispatch(cmd.id, cmd.label, () => cmd.run!(endpoint));
				}}
			/>

			{/* selective-restart confirm — naming the resource being cycled */}
			<ConfirmDialog
				open={restartRow !== null}
				title={restartRow ? `Restart ${labelForRow(restartRow.key)}?` : ''}
				body={
					restartRow
						? `Cycle "${labelForRow(restartRow.key)}". State is preserved, but in-flight work on this service is interrupted.`
						: ''
				}
				confirmLabel="Restart"
				onCancel={() => setRestartRow(null)}
				onConfirm={() => void onRestartRow()}
			/>

			{/* snapshot restore/delete confirm */}
			<ConfirmDialog
				open={snapAction !== null}
				danger
				title={
					snapAction?.kind === 'restore'
						? `Restore "${snapAction.snap.label || snapAction.snap.id}"?`
						: `Delete "${snapAction?.snap.label || snapAction?.snap.id}"?`
				}
				body={
					snapAction?.kind === 'restore'
						? (snapAction.snap.graphInputWarning ??
							'Replaces the current chain and container state with this snapshot. Unsaved progress is lost.')
						: 'Permanently delete this snapshot. This cannot be undone.'
				}
				confirmLabel={snapAction?.kind === 'restore' ? 'Restore' : 'Delete'}
				onCancel={() => setSnapAction(null)}
				onConfirm={() => void onSnapshotAction()}
			/>

			{/* snapshot naming dialog */}
			{naming !== null && (
				<div className="overlay" onClick={() => setNaming(null)}>
					<div
						className="panel"
						onClick={(e) => e.stopPropagation()}
						style={{ width: 420, padding: 22, animation: 'popIn .2s ease both' }}
					>
						<div className="row" style={{ gap: 11, marginBottom: 14 }}>
							<div
								style={{
									width: 32,
									height: 32,
									borderRadius: 8,
									display: 'grid',
									placeItems: 'center',
									background: 'color-mix(in oklab, var(--c-blue) 14%, transparent)',
									color: 'var(--c-blue)',
									flex: 'none',
								}}
							>
								<Icon name="camera" size={18} />
							</div>
							<div>
								<h3 style={{ fontSize: 16 }}>Capture snapshot</h3>
								<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>
									Name this point-in-time checkpoint of the whole stack.
								</span>
							</div>
						</div>
						<Input
							autoFocus
							className="mono"
							value={naming}
							onChange={(e) => setNaming(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && naming.trim()) onCapture(naming.trim());
								if (e.key === 'Escape') setNaming(null);
							}}
							placeholder="snapshot-name"
							style={{ width: '100%', marginBottom: 18 }}
						/>
						<div className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
							<Button onClick={() => setNaming(null)}>Cancel</Button>
							<Button
								variant="primary"
								icon="camera"
								disabled={!naming.trim()}
								onClick={() => onCapture(naming.trim())}
							>
								Capture
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* advance-clock dialog (fork only) */}
			{clockTarget !== null && (
				<div className="overlay" onClick={() => setClockTarget(null)}>
					<div
						className="panel"
						onClick={(e) => e.stopPropagation()}
						style={{ width: 440, padding: 22, animation: 'popIn .2s ease both' }}
					>
						<div className="row" style={{ gap: 11, marginBottom: 14 }}>
							<div
								style={{
									width: 32,
									height: 32,
									borderRadius: 8,
									display: 'grid',
									placeItems: 'center',
									background: 'color-mix(in oklab, var(--c-blue) 14%, transparent)',
									color: 'var(--c-blue)',
									flex: 'none',
								}}
							>
								<Icon name="clock" size={18} />
							</div>
							<div>
								<h3 style={{ fontSize: 16 }}>Advance clock</h3>
								<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>
									Fast-forward the forked chain's clock to an absolute epoch-millis timestamp.
								</span>
							</div>
						</div>
						<div className="col" style={{ gap: 8, marginBottom: 18 }}>
							<span className="eyebrow">Target (epoch ms)</span>
							<NumberInput
								autoFocus
								value={clockTarget}
								onChange={(v) => setClockTarget(v)}
								style={{ width: '100%' }}
							/>
							<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
								{new Date(clockTarget).toISOString()}
							</span>
						</div>
						<div className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
							<Button onClick={() => setClockTarget(null)}>Cancel</Button>
							<Button
								variant="primary"
								icon="clock"
								disabled={!Number.isFinite(clockTarget) || clockTarget <= 0}
								onClick={() => onAdvanceClock(clockTarget)}
							>
								Advance
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

/**
 * Indeterminate progress bar matching the design handoff's snapshot meter (a
 * full-width token-colored `.meter` fill with a sweeping highlight). Used for
 * capture and restore, where REAL phase/percent never reaches the dashboard —
 * capture's progress events are engine-internal and carry no projection slice,
 * and restore is a single awaited mutation with no intermediate readout — so an
 * honest indeterminate animation is the truthful viz (no fabricated percent).
 *
 * Reuses the existing `sweep` keyframe (the same one driving `.live-sweep`)
 * rather than the proportional `Meter` atom, which only renders a fixed 0..1
 * fraction.
 */
const IndeterminateMeter = ({ token = 'blue' }: { readonly token?: StatusToken }) => (
	<div className="meter">
		<span
			style={{
				width: '100%',
				background: `linear-gradient(90deg, color-mix(in oklab, var(--c-${token}) 55%, transparent), var(--c-${token}), color-mix(in oklab, var(--c-${token}) 55%, transparent))`,
				backgroundSize: '50% 100%',
				backgroundRepeat: 'no-repeat',
				animation: 'sweep 1.4s linear infinite',
			}}
		/>
	</div>
);
