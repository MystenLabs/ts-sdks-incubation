// Persistent top status header: identity + mode/phase badges, a mono health
// summary, the ⌘K search trigger, theme/console icon-buttons, and the live
// connection indicator. Projection-derived bits are guarded behind `projection`.

import { navigate } from '../lib/router.ts';
import { summarize } from '../lib/derive.ts';
import type { Projection } from '../lib/types.ts';
import type { StackMode } from '../lib/api.ts';
import type { Connection } from '../lib/useProjection.ts';
import { Dot, Icon, IconButton } from '../ui/index.ts';
import { phaseToken } from './phase.ts';

export interface StatusHeaderProps {
	readonly projection: Projection | null;
	/** Resolved stack mode (fork/local/live). `identity.network` only carries the
	 *  node's network family, so a fork is surfaced from this separate signal. */
	readonly mode: StackMode | null;
	readonly connection: Connection;
	readonly onOpenPalette: () => void;
	readonly onToggleTheme: () => void;
	readonly theme: string;
}

const CONN: Record<
	Connection,
	{ token: 'green' | 'yellow' | 'red'; label: string; pulse: boolean }
> = {
	connecting: { token: 'yellow', label: 'connecting', pulse: true },
	live: { token: 'green', label: 'live', pulse: true },
	error: { token: 'red', label: 'offline', pulse: false },
};

const divider = <span style={{ width: 1, height: 22, background: 'var(--line)' }} />;

export const StatusHeader = ({
	projection,
	mode,
	connection,
	onOpenPalette,
	onToggleTheme,
	theme,
}: StatusHeaderProps) => {
	const conn = CONN[connection];

	return (
		<header
			className="row between"
			style={{
				height: 'var(--header-h)',
				padding: '0 22px',
				borderBottom: '1px solid var(--line)',
				background: 'color-mix(in oklab, var(--bg-panel) 50%, transparent)',
				backdropFilter: 'blur(8px)',
				flex: 'none',
				zIndex: 5,
				gap: 16,
			}}
		>
			<div className="row" style={{ gap: 14, minWidth: 0 }}>
				{projection && (
					<>
						<div className="row" style={{ gap: 9 }}>
							<Dot token="green" />
							<span style={{ fontWeight: 560 }}>{projection.identity.app}</span>
							<span
								className="badge"
								style={{
									height: 20,
									fontSize: 10.5,
									textTransform: 'uppercase',
									letterSpacing: '.06em',
									color: 'var(--c-cyan)',
								}}
							>
								{projection.identity.network}
							</span>
							{mode === 'fork' && (
								<span
									className="badge"
									title="Forked upstream network — a local node loaded with upstream state"
									style={{
										height: 20,
										fontSize: 10.5,
										textTransform: 'uppercase',
										letterSpacing: '.06em',
										color: 'var(--c-yellow)',
										borderColor: 'color-mix(in oklab, var(--c-yellow) 32%, var(--line-strong))',
									}}
								>
									fork
								</span>
							)}
						</div>
						{divider}
						{(() => {
							const tok = phaseToken(projection.cycle.phase);
							const summary = summarize(projection.rows);
							return (
								<>
									<span
										className="badge"
										style={{
											height: 20,
											borderColor: `color-mix(in oklab, var(--c-${tok}) 32%, var(--line-strong))`,
										}}
									>
										<Dot token={tok} pulse={projection.cycle.phase !== 'running'} />
										<span style={{ color: `var(--c-${tok})`, fontSize: 11 }}>
											cycle #{projection.cycle.id} · {projection.cycle.phase}
										</span>
									</span>
									<span className="mono trunc" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
										{summary.ready}/{summary.total} ready
									</span>
								</>
							);
						})()}
					</>
				)}
			</div>

			<div className="row" style={{ gap: 8 }}>
				<button
					type="button"
					className="btn btn-sm btn-ghost"
					onClick={onOpenPalette}
					style={{ color: 'var(--tx-lo)' }}
				>
					<Icon name="search" size={14} /> Search <kbd>⌘K</kbd>
				</button>
				{divider}
				<IconButton
					icon={theme === 'dark' ? 'zap' : 'box'}
					label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
					onClick={onToggleTheme}
				/>
				<IconButton icon="terminal" label="Console (l)" onClick={() => navigate('activity')} />
				<span
					className="badge"
					style={{
						height: 28,
						borderColor: `color-mix(in oklab, var(--c-${conn.token}) 30%, var(--line-strong))`,
					}}
					title={`Projection stream: ${conn.label}`}
				>
					<Dot token={conn.token} pulse={conn.pulse} />
					<span style={{ fontSize: 11, color: `var(--c-${conn.token})` }}>{conn.label}</span>
				</span>
			</div>
		</header>
	);
};
