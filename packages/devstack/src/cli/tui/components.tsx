// Ink components for the `devstack up` TUI. Layout:
//
//   <LogStream />                                 logs commit to scrollback (Static)
//   ────── dynamic redraw zone (anchored at the bottom) ──────
//   <Header />                                    app · stack · network · rpc · counts/uptime
//   <StatusTable /> | <RegistryView /> | <ShutdownPanel />
//   <Footer />                                    key hints
//
// Components consume the InkRenderer's pub/sub store via
// `useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)`
// — version-counter snapshots so React doesn't bail out on reference-equal
// state.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text } from 'ink';
import Spinner from 'ink-spinner';

import type { Action, ActionStatus } from '../../core/types.js';
import { formatMs } from '../../runtime/renderers/plain.js';
import { type InkColor, buildPluginColorMap } from '../../runtime/renderers/plugin-colors.js';
import {
	type RegistryOutput,
	groupRegistryByProvider,
} from '../../runtime/renderers/registry-outputs.js';
import type { Store, TuiState } from './store.js';

/** Plugin color lookup derived from the current `pluginOrder`.
 * Memoized per-render via React's reconciler (the maps are passed
 * down as props instead of re-derived in every component). */
function usePluginColors(state: TuiState): Map<string, InkColor> {
	return buildPluginColorMap(state.pluginOrder).ink;
}

const STATUS_GLYPH: Record<ActionStatus, string> = {
	idle: '·',
	queued: '·',
	running: '⟳',
	ok: '✓',
	failed: '✗',
	skipped: '–',
	stale: '⟲',
	dirty: '◌',
};

/** Mapping for the status word in the row. `idle/queued/skipped` get
 * undefined (caller renders with `<Text dimColor>` for theme-portable
 * gray); `running/ok/failed/stale/dirty` get explicit colors so the
 * eye lands on them. */
const STATUS_INK_COLOR: Partial<Record<ActionStatus, InkColor>> = {
	running: 'cyan',
	ok: 'green',
	failed: 'red',
	stale: 'yellow',
	dirty: 'yellow',
};

function useStore(store: Store): TuiState {
	useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
	return store.get();
}

/** Re-render every `intervalMs` so live durations (uptime, running
 * elapsed, shutdown spinner tails) stay current without the supervisor
 * having to mutate the store every tick. */
function useTick(intervalMs: number): void {
	const [, set] = useState(0);
	useEffect(() => {
		const id = setInterval(() => set((n) => n + 1), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
}

export function Header({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	useTick(1_000);
	const counts = countByStatus(state);
	const uptime = Date.now() - state.startedAtMs;
	// Two compact rows of metadata. Right-align the dynamic counts so
	// the user's eye lands on the same column as the row swaps; the
	// `flexGrow` spacer scales with the terminal width.
	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			<Box>
				<Text bold>devstack up</Text>
				<Text dimColor>{`  ${state.appName} · ${state.stack} · ${state.network}`}</Text>
				<Box flexGrow={1} />
				<Text dimColor>uptime {formatMs(uptime)}</Text>
			</Box>
			<Box>
				{state.rpcUrl !== undefined ? (
					<>
						<Text dimColor>rpc </Text>
						<Text color="cyan">{state.rpcUrl}</Text>
					</>
				) : (
					<Text dimColor>rpc —</Text>
				)}
				<Box flexGrow={1} />
				<Text color="green">{counts.ok}</Text>
				<Text dimColor>/</Text>
				<Text>{counts.total}</Text>
				<Text dimColor> ok</Text>
				{counts.running > 0 && (
					<>
						<Text dimColor> · </Text>
						<Text color="cyan">{counts.running}</Text>
						<Text dimColor> running</Text>
					</>
				)}
				{counts.failed > 0 && (
					<>
						<Text dimColor> · </Text>
						<Text color="red">{counts.failed}</Text>
						<Text dimColor> failed</Text>
					</>
				)}
			</Box>
		</Box>
	);
}

interface StatusCounts {
	ok: number;
	running: number;
	failed: number;
	total: number;
}

function countByStatus(state: TuiState): StatusCounts {
	const c: StatusCounts = { ok: 0, running: 0, failed: 0, total: state.actions.length };
	for (const [, s] of state.statuses) {
		if (s === 'ok') c.ok++;
		else if (s === 'running') c.running++;
		else if (s === 'failed') c.failed++;
	}
	return c;
}

export function StatusTable({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	useTick(250);
	const groups = groupByPlugin(state.actions);
	const colors = usePluginColors(state);
	// Resolve registry-derived outputs for every action once per render
	// (cheap snapshot walk) so each StatusRow can pull its own slice
	// without each one re-walking the registry.
	const outputs =
		state.registry !== null ? groupRegistryByProvider(state.registry) : new Map();
	return (
		<Box flexDirection="column" paddingX={1}>
			{groups.map(({ plugin, actions }) => (
				<PluginGroup
					key={plugin}
					plugin={plugin}
					actions={actions}
					state={state}
					color={colors.get(plugin) ?? 'gray'}
					outputs={outputs}
				/>
			))}
		</Box>
	);
}

interface PluginGroup {
	plugin: string;
	actions: Action[];
}

function groupByPlugin(actions: Action[]): PluginGroup[] {
	const order: string[] = [];
	const map = new Map<string, Action[]>();
	for (const a of actions) {
		const p = a.plugin ?? 'misc';
		if (!map.has(p)) {
			map.set(p, []);
			order.push(p);
		}
		map.get(p)!.push(a);
	}
	return order.map((plugin) => ({ plugin, actions: map.get(plugin)! }));
}

function PluginGroup(props: {
	plugin: string;
	actions: Action[];
	state: TuiState;
	color: InkColor;
	outputs: Map<string, RegistryOutput[]>;
}): React.ReactElement {
	const { plugin, actions, state, color, outputs } = props;
	let healthy = 0;
	let running = 0;
	let failed = 0;
	for (const a of actions) {
		const s = state.statuses.get(a.name);
		if (s === 'ok') healthy++;
		else if (s === 'running') running++;
		else if (s === 'failed') failed++;
	}
	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={color} bold>
					{plugin}
				</Text>
				<Text dimColor>{'  '}</Text>
				<Text color={healthy === actions.length ? 'green' : undefined} dimColor={healthy !== actions.length}>
					{healthy}/{actions.length}
				</Text>
				{running > 0 && (
					<>
						<Text dimColor> · </Text>
						<Text color="cyan">{running} running</Text>
					</>
				)}
				{failed > 0 && (
					<>
						<Text dimColor> · </Text>
						<Text color="red">{failed} failed</Text>
					</>
				)}
			</Box>
			{actions.map((a) => (
				<StatusRow
					key={a.name}
					action={a}
					state={state}
					outputs={outputs.get(a.name)}
				/>
			))}
		</Box>
	);
}

function StatusRow(props: {
	action: Action;
	state: TuiState;
	outputs: RegistryOutput[] | undefined;
}): React.ReactElement {
	const { action, state, outputs } = props;
	const status: ActionStatus = state.statuses.get(action.name) ?? 'idle';
	const start = state.startTimes.get(action.name);
	const settle = state.settleTimes.get(action.name);
	const failure = state.failures.get(action.name);
	let dt = '';
	if (status === 'running' && start !== undefined) dt = `+${formatMs(Date.now() - start)}`;
	else if (settle !== undefined && start !== undefined) dt = formatMs(settle - start);
	const statusColor = STATUS_INK_COLOR[status];
	const shortName = stripPluginPrefix(action.name, action.plugin);
	return (
		<Box>
			{/* col 1: status glyph + spinner */}
			<Box width={2}>
				{status === 'running' ? (
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
				) : (
					<Text color={statusColor} dimColor={statusColor === undefined}>
						{STATUS_GLYPH[status]}
					</Text>
				)}
			</Box>
			{/* col 2: short action name (plugin prefix stripped — the
			 * plugin section header above already carries that signal) */}
			<Box width={26}>
				<Text>{shortName}</Text>
			</Box>
			{/* col 3: action type word, dim. The type carries what the
			 * action does ("publish", "service", "build", …); the
			 * lifecycle status is in the glyph + color. */}
			<Box width={12}>
				<Text dimColor>{action.type.toLowerCase()}</Text>
			</Box>
			{/* col 4: duration — `+N` while running, settled time otherwise */}
			<Box width={10}>
				<Text dimColor>{dt}</Text>
			</Box>
			{/* col 5: detail (flex) — failure message, scheduling text,
			 * or registry-derived outputs */}
			<Box flexGrow={1}>
				<RowDetail action={action} status={status} failure={failure} outputs={outputs} />
			</Box>
		</Box>
	);
}

/** `sui.localnet` → `localnet`, `walrus.node-0` → `node-0`,
 * unprefixed names pass through. Plugin grouping above the row
 * already carries the prefix as identity. */
function stripPluginPrefix(name: string, plugin: string | undefined): string {
	if (plugin === undefined) return name;
	const prefix = `${plugin}.`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Detail-column rules. Priority order:
 *   failure > stale/dirty > queued > skipped > idle (waiting on deps) >
 *   ok+outputs > blank.
 *
 * The terminal `idle` and `queued` cases are common; we show `waiting
 * on …` only when there's actual upstream to name. Settled actions
 * without registry outputs leave the column blank so the eye flows
 * past them to the live ones. */
function RowDetail(props: {
	action: Action;
	status: ActionStatus;
	failure?: string;
	outputs?: RegistryOutput[];
}): React.ReactElement | null {
	const { action, status, failure, outputs } = props;
	const needs = (action.needs ?? []).filter((n) => !n.endsWith(':before'));
	if (failure !== undefined) return <Text color="red">{failure}</Text>;
	if (status === 'failed') return null;
	if (status === 'stale' || status === 'dirty') {
		return <Text color="yellow">inputs changed</Text>;
	}
	if (status === 'queued') return <Text dimColor>scheduling</Text>;
	if (status === 'skipped') return <Text dimColor>upstream failed</Text>;
	if (status === 'idle' && needs.length > 0) {
		return <Text dimColor>waiting on {needs.join(', ')}</Text>;
	}
	if (status === 'ok' && outputs !== undefined && outputs.length > 0) {
		return <Outputs outputs={outputs} />;
	}
	return null;
}

function Outputs(props: { outputs: RegistryOutput[] }): React.ReactElement {
	return (
		<Box flexDirection="column">
			{props.outputs.map((o, i) => (
				<Box key={`${o.label}-${i}-${o.value}`}>
					<Text dimColor>{o.label} </Text>
					<Text color="cyan">{o.value}</Text>
				</Box>
			))}
		</Box>
	);
}

export function ShutdownPanel({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	useTick(150);
	if (state.shutdown === null) return <></>;
	const hooks = [...state.shutdown.hooks.values()];
	const total = hooks.length;
	const done = hooks.filter((h) => h.status === 'done').length;
	const failed = hooks.filter((h) => h.status === 'failed').length;
	const elapsed = Date.now() - state.shutdown.startedAtMs;
	const summary = state.shutdown.summary;
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box>
				<Text color="yellow" bold>
					shutdown
				</Text>
			</Box>
			<Box>
				{summary === undefined ? (
					<>
						<Box width={2}>
							<Text color="yellow">
								<Spinner type="dots" />
							</Text>
						</Box>
						<Text>shutting down — {total} hook{total === 1 ? '' : 's'}</Text>
					</>
				) : summary.failed === 0 ? (
					<>
						<Box width={2}>
							<Text color="green">✓</Text>
						</Box>
						<Text color="green">shutdown complete</Text>
					</>
				) : (
					<>
						<Box width={2}>
							<Text color="yellow">⚠</Text>
						</Box>
						<Text color="yellow">shutdown complete (with errors)</Text>
					</>
				)}
				<Box flexGrow={1} />
				<Text dimColor>
					{done}/{total} ok{failed > 0 ? `, ${failed} failed` : ''} · {formatMs(summary?.durationMs ?? elapsed)}
				</Text>
			</Box>
			{hooks.map((h) => {
				const dur = h.startedAtMs !== undefined ? (h.settledAtMs ?? Date.now()) - h.startedAtMs : 0;
				return (
					<Box key={h.label}>
						<Box width={2}>
							{h.status === 'pending' && <Text dimColor>·</Text>}
							{h.status === 'running' && (
								<Text color="yellow">
									<Spinner type="dots" />
								</Text>
							)}
							{h.status === 'done' && <Text color="green">✓</Text>}
							{h.status === 'failed' && <Text color="red">✗</Text>}
						</Box>
						<Box width={32}>
							<Text color={h.status === 'failed' ? 'red' : undefined}>{h.label}</Text>
						</Box>
						<Box width={10}>
							<Text dimColor>{h.status === 'pending' ? 'pending' : formatMs(dur)}</Text>
						</Box>
						<Box flexGrow={1}>
							{h.status === 'running' && <Text dimColor>stopping…</Text>}
							{h.status === 'done' && <Text dimColor>— exited cleanly</Text>}
							{h.status === 'failed' && h.detail !== undefined && (
								<Text color="red">— {h.detail}</Text>
							)}
							{h.status === 'pending' && <Text dimColor>— queued</Text>}
						</Box>
					</Box>
				);
			})}
		</Box>
	);
}

/** Stream every log line into terminal scrollback via ink's `<Static>`.
 * Each line is committed to stdout once and never redrawn — ink writes
 * it above whatever dynamic block is currently rendered, then continues
 * the dynamic redraw below. The user scrolls the terminal up to see
 * history; we don't manage a virtual log buffer at all. */
export function LogStream({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	const colors = usePluginColors(state);
	const pluginByAction = new Map<string, string | undefined>();
	for (const a of state.actions) pluginByAction.set(a.name, a.plugin);
	return (
		<Static items={state.logs}>
			{(line) => (
				<LogRow
					key={line.id}
					line={line}
					pluginByAction={pluginByAction}
					colors={colors}
				/>
			)}
		</Static>
	);
}

export function RegistryView({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	const reg = state.registry;
	if (reg === null) {
		return (
			<Box paddingX={1} flexGrow={1}>
				<Text dimColor>registry empty</Text>
			</Box>
		);
	}
	// Walk the snapshot in a stable order: built-in kinds first, then
	// any plugin namespaces (`walrus`, `seal`, …) the snapshot's
	// `[namespace: string]: unknown` index signature exposes.
	const builtInKinds = ['packages', 'accounts', 'services'] as const;
	const namespaceKeys: string[] = [];
	for (const k of Object.keys(reg)) {
		if (!(builtInKinds as readonly string[]).includes(k)) namespaceKeys.push(k);
	}
	namespaceKeys.sort();
	return (
		<Box flexDirection="column" paddingX={1} flexGrow={1}>
			<RegistrySection title="packages" rows={formatPackages(reg.packages)} />
			<RegistrySection title="accounts" rows={formatAccounts(reg.accounts)} />
			<RegistrySection title="services" rows={formatServices(reg.services)} />
			{namespaceKeys.map((ns) => (
				<RegistryNamespace key={ns} name={ns} bag={reg[ns] as Record<string, unknown[]>} />
			))}
		</Box>
	);
}

function RegistrySection(props: {
	title: string;
	rows: Array<{ label: string; value: string }>;
}): React.ReactElement {
	const { title, rows } = props;
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text bold>{title}</Text>
			{rows.length === 0 ? (
				<Box paddingLeft={2}>
					<Text dimColor>—</Text>
				</Box>
			) : (
				rows.map((r, i) => (
					<Box key={`${r.label}-${i}`} paddingLeft={2}>
						<Text dimColor>{r.label.padEnd(28)}</Text>
						<Text>{r.value}</Text>
					</Box>
				))
			)}
		</Box>
	);
}

function RegistryNamespace(props: {
	name: string;
	bag: Record<string, unknown[]>;
}): React.ReactElement {
	const { name, bag } = props;
	const entries = Object.entries(bag).sort(([a], [b]) => a.localeCompare(b));
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text bold>{name}</Text>
			{entries.length === 0 ? (
				<Box paddingLeft={2}>
					<Text dimColor>—</Text>
				</Box>
			) : (
				entries.map(([kind, items]) => (
					<Box key={kind} flexDirection="column" paddingLeft={2}>
						<Text dimColor>
							{kind} ({items.length})
						</Text>
						{items.map((item, i) => {
							const named = item as { name?: string };
							return (
								<Box key={`${kind}-${i}`} paddingLeft={2}>
									<Text dimColor>{(named.name ?? `[${i}]`).padEnd(26)}</Text>
									<Text>{summarize(item)}</Text>
								</Box>
							);
						})}
					</Box>
				))
			)}
		</Box>
	);
}

interface PackageEntry {
	name: string;
	packageId: string;
	chainId?: string;
}

function formatPackages(items: PackageEntry[]): Array<{ label: string; value: string }> {
	return items.map((p) => ({ label: p.name, value: p.packageId }));
}

interface AccountEntry {
	name: string;
	address: string;
	role?: string;
	funded?: boolean;
}

function formatAccounts(items: AccountEntry[]): Array<{ label: string; value: string }> {
	return items.map((a) => ({
		label: a.name,
		value: `${a.address}${a.role ? `  ${a.role}` : ''}${a.funded === false ? '  (unfunded)' : ''}`,
	}));
}

interface ServiceEntry {
	name: string;
	kind: string;
	url: string;
	port: number;
	providedBy?: string;
}

function formatServices(items: ServiceEntry[]): Array<{ label: string; value: string }> {
	return items.map((s) => ({
		label: s.name,
		value: `${s.url}${s.providedBy ? `  ← ${s.providedBy}` : ''}`,
	}));
}

/** One-line summary of an unknown registry item — first scalar fields
 * we recognize, comma-separated. Falls back to the JSON literal so
 * users can still see something for plugin-namespaced kinds we don't
 * have a shape for. */
function summarize(item: unknown): string {
	if (item === null || typeof item !== 'object') return String(item);
	const obj = item as Record<string, unknown>;
	const fields = ['url', 'address', 'packageId', 'objectId', 'role', 'kind'];
	const parts: string[] = [];
	for (const f of fields) {
		const v = obj[f];
		if (typeof v === 'string') parts.push(v);
	}
	if (parts.length > 0) return parts.join('  ');
	try {
		const json = JSON.stringify(obj);
		return json.length > 80 ? `${json.slice(0, 79)}…` : json;
	} catch {
		return '(unserializable)';
	}
}

function LogRow(props: {
	line: { ts: number; src: string; msg: string };
	pluginByAction: Map<string, string | undefined>;
	colors: Map<string, InkColor>;
}): React.ReactElement {
	const { line, pluginByAction, colors } = props;
	const plugin =
		line.src === 'supervisor' ? 'supervisor' : pluginByAction.get(line.src);
	const color = colors.get(plugin ?? '') ?? 'gray';
	const ts = formatTs(line.ts);
	return (
		<Text>
			<Text dimColor>[{ts}] </Text>
			<Text color={color}>{line.src}</Text>
			<Text> {line.msg}</Text>
		</Text>
	);
}

function formatTs(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => n.toString().padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function Footer({ store }: { store: Store }): React.ReactElement {
	const state = useStore(store);
	const Hint = ({ k, label }: { k: string; label: string }): React.ReactElement => (
		<Text>
			<Text color="cyan">{k}</Text>
			<Text dimColor> {label}   </Text>
		</Text>
	);
	const inspectLabel = state.mainView === 'registry' ? 'status' : 'registry';
	return (
		<Box paddingX={1} marginTop={1}>
			<Hint k="i" label={inspectLabel} />
			<Hint k="r" label="retry" />
			<Hint k="q" label="quit" />
		</Box>
	);
}
