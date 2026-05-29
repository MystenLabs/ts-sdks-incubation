// Controls & Operations panel — the engine-command surface.
//
// Honest port of the design handoff's Controls screen: only the commands the
// dashboard API actually supports are exposed (Restart, Apply, Codegen, Capture
// snapshot). The handoff's Prune / Advance-clock / Wipe / Shutdown cards have no
// backing mutation and are omitted. Each action toasts its `CommandResult` and
// forces a projection refresh; a per-action `busy` lock disables the grid while
// a command is in flight. There is no snapshot-list API, so the Snapshots
// section renders the capture control + an honest empty state rather than a
// fabricated table.

import { useState } from 'react';
import {
	type CommandResult,
	applyStack,
	captureSnapshot,
	restartPlugin,
	restartStack,
	runCodegen,
} from '../lib/api.ts';
import { labelForRow, statusDisplay } from '../lib/derive.ts';
import { timeAgo } from '../lib/format.ts';
import { useToast } from '../lib/toast.tsx';
import type { Row } from '../lib/types.ts';
import {
	Button,
	ConfirmDialog,
	Dot,
	EmptyState,
	Icon,
	type IconName,
	Input,
	SectionHead,
	type StatusToken,
} from '../ui/index.ts';
import type { PanelProps } from './types.ts';

/** A single command tile in the grid. */
interface Command {
	readonly id: string;
	readonly label: string;
	readonly icon: IconName;
	readonly desc: string;
	readonly token: StatusToken;
	/** Gate behind a ConfirmDialog before dispatch. */
	readonly confirm?: boolean;
	/** Run via a small naming dialog (capture snapshot). */
	readonly naming?: boolean;
	/** Execute the underlying mutation; the caller handles toast + refresh. */
	readonly run: (endpoint: string, name?: string) => Promise<CommandResult>;
}

const COMMANDS: ReadonlyArray<Command> = [
	{
		id: 'restart',
		label: 'Restart stack',
		icon: 'refresh',
		desc: 'Cycle all services, keep state',
		token: 'yellow',
		confirm: true,
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
		id: 'capture',
		label: 'Capture snapshot',
		icon: 'camera',
		desc: 'Checkpoint the whole stack',
		token: 'blue',
		naming: true,
		run: (endpoint, name) => captureSnapshot(endpoint, name),
	},
];

export const ControlsPanel = ({ projection, endpoint, refresh }: PanelProps) => {
	const toast = useToast();
	// id of the in-flight command (whole-grid lock), or null.
	const [busy, setBusy] = useState<string | null>(null);
	// Command awaiting confirmation, or null.
	const [confirm, setConfirm] = useState<Command | null>(null);
	// Proposed snapshot name while the naming dialog is open, or null.
	const [naming, setNaming] = useState<string | null>(null);

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
		} catch (err) {
			toast.error(err instanceof Error ? err.message : `${label} failed`);
		} finally {
			setBusy(null);
		}
	};

	const onCard = (cmd: Command): void => {
		if (busy) return;
		if (cmd.naming) setNaming(`snapshot-${Date.now()}`);
		else if (cmd.confirm) setConfirm(cmd);
		else void dispatch(cmd.id, cmd.label, () => cmd.run(endpoint));
	};

	const onRestartRow = (row: Row): void =>
		void dispatch(`restart/${row.key}`, `Restart ${labelForRow(row.key)}`, () =>
			restartPlugin(endpoint, row.key),
		);

	const onCapture = (name: string): void => {
		setNaming(null);
		void dispatch('capture', 'Capture snapshot', () => captureSnapshot(endpoint, name));
	};

	const build = projection.stackBuild;

	return (
		<div className="col" style={{ gap: 22 }}>
			<div>
				<h2 style={{ fontSize: 19 }}>Controls &amp; Operations</h2>
				<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
					Engine commands dispatched in-process. The UI waits for the projection to reflect the
					effect.
				</p>
			</div>

			{/* command grid — only API-backed commands */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
					gap: 14,
				}}
			>
				{COMMANDS.map((cmd) => {
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
								{active && <span className="dot dot-cyan dot-pulse" />}
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
								<Button key={row.key} sm disabled={busy !== null} onClick={() => onRestartRow(row)}>
									<Dot token={display.token} pulse={display.pulse} /> {labelForRow(row.key)}
								</Button>
							);
						})}
					</div>
				)}
			</div>

			{/* build progress — only when the supervisor is actively building */}
			{build.length > 0 && (
				<div className="panel panel-pad">
					<SectionHead title="Build progress" count={build.length} />
					<div className="col" style={{ gap: 12 }}>
						{build.map((entry, i) => (
							<div key={`${entry.pluginKey ?? 'stack'}#${i}`} className="col" style={{ gap: 6 }}>
								<div className="row between">
									<span className="row" style={{ gap: 8 }}>
										<span className="dot dot-blue dot-pulse" />
										<span style={{ fontSize: 13, fontWeight: 530 }}>
											{entry.pluginKey ? labelForRow(entry.pluginKey) : 'stack'}
										</span>
										<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>{entry.phase}</span>
									</span>
									<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
										{entry.progress} · {timeAgo(entry.startedAt)}
									</span>
								</div>
								<div className="meter">
									<span style={{ width: '100%', background: 'var(--c-blue)' }} />
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* snapshots — capture only; no list API exists */}
			<div className="panel panel-pad">
				<SectionHead
					title="Snapshots"
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
				<EmptyState
					icon="camera"
					title="Snapshot history isn't exposed by the API yet"
					hint="Captured snapshots are written by the engine; the dashboard can trigger a capture but cannot list, restore, or delete them."
				/>
			</div>

			<ConfirmDialog
				open={confirm !== null}
				danger
				title={confirm?.label ?? ''}
				body="Cycle every service in the stack. State is preserved, but in-flight work is interrupted."
				confirmLabel={confirm?.label}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					const cmd = confirm;
					setConfirm(null);
					if (cmd) void dispatch(cmd.id, cmd.label, () => cmd.run(endpoint));
				}}
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
		</div>
	);
};
