// Left navigation rail: brand block, grouped nav items, footer status capsule.
// Pure presentation — routing is delegated to the `lib/router` `navigate` seam
// and active-state is driven by the `route` prop. Mirrors app.jsx's `<aside>`.

import { navigate } from '../lib/router.ts';
import type { StatusToken } from '../lib/derive.ts';
import type { CyclePhase } from '../lib/types.ts';
import { Icon } from '../ui/index.ts';
import { humanize } from '../lib/format.ts';
import type { NavSection } from './nav.ts';
import { phaseToken } from './phase.ts';

export interface NavRailProps {
	/** Nav sections to render, derived from the live projection. */
	readonly sections: ReadonlyArray<NavSection>;
	/** Current route id (`overview`, `services`, …, or `plugin:<key>`). */
	readonly route: string;
	readonly collapsed: boolean;
	readonly onToggleCollapsed: () => void;
	/** Cycle phase, for the footer capsule dot + label. */
	readonly phase: CyclePhase;
	readonly cycleId: number;
	readonly ready: number;
	readonly total: number;
	/** Mode/network badge (the projection has no separate `mode`). */
	readonly mode: string;
	/** Number of failed rows — drives the Services pulsing-red indicator. */
	readonly failedCount: number;
}

const railBackground =
	'linear-gradient(180deg, color-mix(in oklab, var(--bg-panel) 70%, var(--bg-base)), var(--bg-base))';

export const NavRail = ({
	sections,
	route,
	collapsed,
	onToggleCollapsed,
	phase,
	cycleId,
	ready,
	total,
	mode,
	failedCount,
}: NavRailProps) => {
	const tok: StatusToken = phaseToken(phase);
	const phasePulse = phase !== 'running';

	return (
		<aside
			className="col"
			style={{
				borderRight: '1px solid var(--line)',
				background: railBackground,
				overflow: 'hidden',
				zIndex: 2,
			}}
		>
			{/* brand */}
			<button
				type="button"
				className="row"
				onClick={onToggleCollapsed}
				title={collapsed ? 'Expand nav' : 'Collapse nav'}
				style={{
					gap: 11,
					padding: collapsed ? '0' : '0 18px',
					justifyContent: collapsed ? 'center' : 'flex-start',
					height: 'var(--header-h)',
					borderBottom: '1px solid var(--line)',
					flex: 'none',
					background: 'transparent',
					border: 'none',
					borderRadius: 0,
					cursor: 'pointer',
					textAlign: 'left',
				}}
			>
				<div
					style={{
						width: 32,
						height: 32,
						borderRadius: 9,
						background:
							'linear-gradient(145deg, var(--accent), color-mix(in oklab, var(--accent) 60%, #000))',
						color: 'var(--accent-ink)',
						display: 'grid',
						placeItems: 'center',
						flex: 'none',
						fontWeight: 700,
						fontFamily: 'var(--font-mono)',
						fontSize: 17,
						boxShadow: '0 0 0 1px var(--accent-line), 0 6px 18px -6px var(--accent-glow)',
					}}
				>
					◆
				</div>
				{!collapsed && (
					<div className="col" style={{ gap: 1 }}>
						<span style={{ fontWeight: 620, letterSpacing: '-.02em', lineHeight: 1, fontSize: 15 }}>
							devstack
						</span>
						<span
							className="mono"
							style={{ fontSize: 10, color: 'var(--tx-lo)', letterSpacing: '.02em' }}
						>
							orchestrator · v0.9.4
						</span>
					</div>
				)}
			</button>

			{/* nav */}
			<nav
				className="col scroll-y grow"
				style={{ gap: 1, padding: collapsed ? '12px 10px' : '14px 12px' }}
			>
				{sections.map((section, si) => (
					<div key={section.label ?? `top-${si}`} className="col" style={{ gap: 1 }}>
						{section.label &&
							(collapsed ? (
								si > 0 && (
									<div style={{ height: 1, background: 'var(--line)', margin: '9px 8px' }} />
								)
							) : (
								<div className="eyebrow" style={{ padding: '14px 11px 6px' }}>
									{section.label}
								</div>
							))}
						{section.items.map((item) => {
							const active = route === item.id;
							const showFail = item.id === 'services' && failedCount > 0;
							return (
								<button
									key={item.id}
									type="button"
									className={'nav-item ' + (active ? 'on' : '')}
									onClick={() => navigate(item.id)}
									title={collapsed ? item.label : undefined}
									style={
										collapsed
											? {
													position: 'relative',
													justifyContent: 'center',
													padding: 0,
													width: 40,
													height: 40,
													margin: '0 auto',
												}
											: undefined
									}
								>
									<Icon name={item.icon} size={17} />
									{!collapsed && <span>{item.label}</span>}
									{showFail && (
										<span
											className="dot dot-red dot-pulse nav-badge"
											style={
												collapsed
													? { position: 'absolute', top: 7, right: 7, marginLeft: 0 }
													: undefined
											}
										/>
									)}
								</button>
							);
						})}
					</div>
				))}
			</nav>

			{/* footer status capsule */}
			{collapsed ? (
				<div className="col" style={{ alignItems: 'center', padding: '12px 0', flex: 'none' }}>
					<span
						className={`dot dot-${tok} ${phasePulse ? 'dot-pulse' : ''}`}
						style={{ width: 9, height: 9 }}
					/>
				</div>
			) : (
				<div style={{ padding: 12, flex: 'none' }}>
					<div className="panel" style={{ padding: '11px 13px', background: 'var(--bg-base)' }}>
						<div className="row between" style={{ marginBottom: 9 }}>
							<span className="row" style={{ gap: 7 }}>
								<span className={`dot dot-${tok} ${phasePulse ? 'dot-pulse' : ''}`} />
								<span style={{ fontSize: 12, fontWeight: 540 }}>{humanize(phase)}</span>
							</span>
							<span
								className="badge"
								style={{
									height: 18,
									fontSize: 9.5,
									textTransform: 'uppercase',
									letterSpacing: '.07em',
									color: 'var(--c-cyan)',
								}}
							>
								{mode}
							</span>
						</div>
						<div className="row between mono" style={{ fontSize: 10.5, color: 'var(--tx-lo)' }}>
							<span>cycle #{cycleId}</span>
							<span>
								{ready}/{total} ready
							</span>
						</div>
					</div>
				</div>
			)}
		</aside>
	);
};
