// Composition root: providers, the app-shell layout (nav rail + status header +
// routed scrollable content), the command palette, global keyboard shortcuts,
// and the connection/empty/error gates. The live data layer is the single
// `useProjection(endpoint)` hook; mutations go through `lib/api`.

import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { useRoute, navigate } from './lib/router.ts';
import { useProjection } from './lib/useProjection.ts';
import { summarize } from './lib/derive.ts';
import { captureSnapshot, restartStack, runCodegen } from './lib/api.ts';
import { ToastProvider, useToast } from './lib/toast.tsx';
import { Banner, Button, EmptyState, Icon, IconButton, Input } from './ui/index.ts';
import { NavRail } from './shell/NavRail.tsx';
import { StatusHeader } from './shell/StatusHeader.tsx';
import { CommandPalette, type Command } from './shell/CommandPalette.tsx';
import { NAV_ITEMS } from './shell/nav.ts';
import type { PanelProps } from './panels/types.ts';

import { OverviewPanel } from './panels/Overview.tsx';
import { ServicesPanel } from './panels/Services.tsx';
import { ConsolePanel } from './panels/Console.tsx';
import { AccountsPanel } from './panels/Accounts.tsx';
import { FaucetPanel } from './panels/Faucet.tsx';
import { ControlsPanel } from './panels/Controls.tsx';
import { ConfigPanel } from './panels/Config.tsx';
import { ExplorerPanel } from './panels/Explorer.tsx';
import { PluginPanel } from './panels/PluginPage.tsx';

// --- Persistence keys + defaults --------------------------------------------

const KEY_ENDPOINT = 'devstack.gql';
const KEY_THEME = 'devstack.theme';
const KEY_NAV = 'devstack.nav';

// Vite types `import.meta.env` custom keys loosely; pin to a string fallback.
const ENV_ENDPOINT = import.meta.env.VITE_DASHBOARD_GQL as string | undefined;
// When the dashboard is served by the devstack plugin it is same-origin with
// its GraphQL API, so default to a same-origin `/graphql`. The standalone Vite
// dev server sets VITE_DASHBOARD_GQL to point at a running stack's endpoint.
const DEFAULT_ENDPOINT =
	ENV_ENDPOINT ??
	(typeof window !== 'undefined'
		? new URL('/graphql', window.location.origin).toString()
		: '/graphql');

const initialEndpoint = (): string => localStorage.getItem(KEY_ENDPOINT) ?? DEFAULT_ENDPOINT;

const initialTheme = (): string => document.documentElement.dataset.theme ?? 'dark';

const initialCollapsed = (): boolean => localStorage.getItem(KEY_NAV) === 'collapsed';

// --- Route → panel map ------------------------------------------------------

const PANELS: Record<string, (props: PanelProps) => JSX.Element> = {
	overview: OverviewPanel,
	services: ServicesPanel,
	activity: ConsolePanel,
	accounts: AccountsPanel,
	faucet: FaucetPanel,
	explorer: ExplorerPanel,
	controls: ControlsPanel,
	config: ConfigPanel,
};

const railBackground =
	'linear-gradient(180deg, color-mix(in oklab, var(--bg-panel) 70%, var(--bg-base)), var(--bg-base))';

// --- Settings popover -------------------------------------------------------

interface SettingsProps {
	readonly endpoint: string;
	readonly onApply: (next: string) => void;
	readonly onClose: () => void;
}

const SettingsPopover = ({ endpoint, onApply, onClose }: SettingsProps) => {
	const [draft, setDraft] = useState(endpoint);
	return (
		<div className="overlay" onClick={onClose}>
			<div
				className="panel panel-pad col"
				onClick={(e) => e.stopPropagation()}
				style={{ width: 460, maxWidth: '92vw', gap: 14, boxShadow: 'var(--sh-pop)' }}
			>
				<div className="row between">
					<h3 style={{ fontSize: 15 }}>Dashboard endpoint</h3>
					<IconButton icon="x" label="Close" onClick={onClose} />
				</div>
				<p style={{ color: 'var(--tx-mid)', fontSize: 12.5, margin: 0 }}>
					The devstack dashboard GraphQL endpoint. Persisted locally.
				</p>
				<Input
					className="mono"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={DEFAULT_ENDPOINT}
					spellCheck={false}
				/>
				<div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
					<Button onClick={onClose}>Cancel</Button>
					<Button
						variant="primary"
						onClick={() => {
							onApply(draft.trim() || DEFAULT_ENDPOINT);
							onClose();
						}}
					>
						Apply
					</Button>
				</div>
			</div>
		</div>
	);
};

// --- Connection / error gates -----------------------------------------------

const Centered = ({ children }: { children: ReactNode }) => (
	<div style={{ position: 'relative', height: '100%' }}>
		<div className="atmos" />
		<div
			className="col"
			style={{
				position: 'relative',
				height: '100%',
				alignItems: 'center',
				justifyContent: 'center',
				zIndex: 1,
				gap: 16,
			}}
		>
			{children}
		</div>
	</div>
);

// --- Shell ------------------------------------------------------------------

const Shell = () => {
	const toast = useToast();
	const route = useRoute();

	const [endpoint, setEndpoint] = useState(initialEndpoint);
	const [theme, setTheme] = useState(initialTheme);
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);

	const data = useProjection(endpoint);
	const { projection } = data;

	// --- Persisted setters ---------------------------------------------------

	const applyEndpoint = useCallback((next: string) => {
		setEndpoint(next);
		localStorage.setItem(KEY_ENDPOINT, next);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme((prev) => {
			const next = prev === 'dark' ? 'light' : 'dark';
			document.documentElement.dataset.theme = next;
			localStorage.setItem(KEY_THEME, next);
			return next;
		});
	}, []);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			localStorage.setItem(KEY_NAV, next ? 'collapsed' : 'rail');
			return next;
		});
	}, []);

	// --- Command actions (mutations + toasts) --------------------------------

	const runCommand = useCallback(
		async (label: string, fn: () => Promise<{ ok: boolean; message: string | null }>) => {
			try {
				const res = await fn();
				if (res.ok) toast.success(res.message ?? `${label} ok`);
				else toast.error(res.message ?? `${label} failed`);
				await data.refresh();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		},
		[data, toast],
	);

	const restart = useCallback(() => {
		toast.info('Restarting stack…');
		void runCommand('Restart', () => restartStack(endpoint));
	}, [endpoint, runCommand, toast]);

	const snapshot = useCallback(() => {
		void runCommand('Snapshot', () => captureSnapshot(endpoint));
	}, [endpoint, runCommand]);

	const codegen = useCallback(() => {
		void runCommand('Codegen', () => runCodegen(endpoint));
	}, [endpoint, runCommand]);

	// --- Command palette entries ---------------------------------------------

	const commands = useMemo<ReadonlyArray<Command>>(() => {
		const nav: Command[] = NAV_ITEMS.map((item) => ({
			id: `go:${item.id}`,
			label: `Go to ${item.label}`,
			icon: item.icon,
			run: () => (item.pluginKey ? navigate('plugin', item.pluginKey) : navigate(item.id)),
		}));
		const actions: Command[] = [
			{ id: 'act:restart', label: 'Restart stack', icon: 'refresh', run: restart },
			{ id: 'act:snapshot', label: 'Capture snapshot', icon: 'camera', run: snapshot },
			{ id: 'act:codegen', label: 'Run codegen', icon: 'cog', run: codegen },
			{
				id: 'act:settings',
				label: 'Edit dashboard endpoint',
				icon: 'plug',
				run: () => setSettingsOpen(true),
			},
		];
		return [...nav, ...actions];
	}, [restart, snapshot, codegen]);

	// --- Global keyboard shortcuts -------------------------------------------

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault();
				setPaletteOpen((p) => !p);
				return;
			}
			const target = e.target as HTMLElement | null;
			const typing =
				target instanceof HTMLInputElement ||
				target instanceof HTMLSelectElement ||
				target instanceof HTMLTextAreaElement ||
				(target?.isContentEditable ?? false);
			if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === '/') {
				e.preventDefault();
				setPaletteOpen(true);
			} else if (e.key === 'r') {
				restart();
			} else if (e.key === 's') {
				navigate('controls');
			} else if (e.key === 'l') {
				navigate('activity');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [restart]);

	// --- Connection / error gate ---------------------------------------------

	if (!projection) {
		const failed = data.connection === 'error';
		return (
			<>
				<Centered>
					{failed ? (
						<>
							<EmptyState
								icon="alert"
								title="Can't reach the dashboard API"
								hint={data.error ?? endpoint}
							/>
							<Button variant="primary" icon="plug" onClick={() => setSettingsOpen(true)}>
								Edit endpoint
							</Button>
						</>
					) : (
						<div className="col" style={{ alignItems: 'center', gap: 12 }}>
							<span className="dot dot-cyan dot-pulse" style={{ width: 12, height: 12 }} />
							<span style={{ color: 'var(--tx-mid)', fontSize: 13 }}>
								Connecting to <span className="mono">{endpoint}</span>…
							</span>
						</div>
					)}
				</Centered>
				{settingsOpen && (
					<SettingsPopover
						endpoint={endpoint}
						onApply={applyEndpoint}
						onClose={() => setSettingsOpen(false)}
					/>
				)}
			</>
		);
	}

	// --- Mounted shell --------------------------------------------------------

	const summary = summarize(projection.rows);
	const panelProps: PanelProps = {
		projection,
		activity: data.activity,
		endpoint,
		connection: data.connection,
		refresh: data.refresh,
	};

	const renderPanel = () => {
		if (route.name === 'plugin' && route.param) {
			return <PluginPanel {...panelProps} pluginKey={route.param} />;
		}
		const Panel = PANELS[route.name] ?? OverviewPanel;
		return <Panel {...panelProps} />;
	};

	return (
		<div
			style={{
				position: 'relative',
				height: '100%',
				display: 'grid',
				gridTemplateColumns: `${collapsed ? 'var(--nav-w-collapsed)' : 'var(--nav-w)'} 1fr`,
				zIndex: 1,
				background: railBackground,
			}}
		>
			<div className="atmos" />

			<NavRail
				route={route.param ? `${route.name}:${route.param}` : route.name}
				collapsed={collapsed}
				onToggleCollapsed={toggleCollapsed}
				phase={projection.cycle.phase}
				cycleId={projection.cycle.id}
				ready={summary.ready}
				total={summary.total}
				mode={projection.identity.network}
				failedCount={summary.failed}
			/>

			<div className="col" style={{ minWidth: 0, height: '100%' }}>
				<StatusHeader
					projection={projection}
					connection={data.connection}
					onOpenPalette={() => setPaletteOpen(true)}
					onToggleTheme={toggleTheme}
					theme={theme}
					onRestart={restart}
				/>

				<main className="scroll-y grow" style={{ padding: '24px 26px' }}>
					{data.connection === 'error' && data.projection != null && (
						<Banner tone="warn" title="Reconnecting…" className="mb-[18px]">
							Lost the live connection — showing the last snapshot.
						</Banner>
					)}
					<div key={route.param ? `${route.name}:${route.param}` : route.name} className="fade-up">
						{renderPanel()}
					</div>
				</main>
			</div>

			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				commands={commands}
			/>

			{settingsOpen && (
				<SettingsPopover
					endpoint={endpoint}
					onApply={applyEndpoint}
					onClose={() => setSettingsOpen(false)}
				/>
			)}

			{/* Settings affordance available from the footer of the rail via palette too. */}
			<button
				type="button"
				className="iconbtn"
				onClick={() => setSettingsOpen(true)}
				title="Dashboard endpoint"
				aria-label="Dashboard endpoint"
				style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 50 }}
			>
				<Icon name="cog" className="ic" />
			</button>
		</div>
	);
};

const App = () => (
	<ToastProvider>
		<Shell />
	</ToastProvider>
);

export default App;
