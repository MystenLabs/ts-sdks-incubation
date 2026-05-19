// Ink components for the devstack TUI.
//
// Layout: a rounded header bar, a single flat node table (one row per
// primitive, no Services/Actions sections), a compact log tail of recent
// globals, and a footer with the keybind hints. Ink owns all
// cursor/clear/diff plumbing so we don't hand-roll any ANSI; that
// responsibility moves entirely out of our codebase.

import { Box, Static, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { EngineHandleShape } from '../engine/engine.js';
import { Effect, Ref } from 'effect';
import type {
	BuildStatus,
	TagStatus,
	TuiEntry,
	TuiEntryKind,
	TuiHeader,
	TuiLog,
	TuiState,
} from '../engine/tui-state.js';

/** The five user-intent sections the TUI groups by. Excludes 'other',
 *  which is the catchall for hand-rolled refs that fall through to
 *  `parseTitle`'s display-prefix grouping. */
type TuiEntryKindLabel = Exclude<TuiEntryKind, 'other'>;

const emptyState: TuiState = {
	entries: [],
	endpoints: [],
	logs: [],
	header: { app: '', stack: 'main', network: 'localnet', buildStatus: 'idle', cycle: 0 },
};

// Single source of truth for the shutdown narration line. Same string fires
// from the q-keypress handler and the launch effect's `onInterrupt` hook so
// the user sees identical copy whether they pressed `q` in the TUI, hit
// Ctrl-C in the terminal, or this process received an external SIGINT.
// "container" is intentionally absent from user-visible copy — the public
// vocabulary is "background services". `devstack wipe --yes` is the
// documented path to a full local reset.
export const SHUTDOWN_LOG_MESSAGE =
	'Shutting down. Sui and other background services stay warm for a fast next start. Run `pnpm exec devstack wipe --yes` to clear all local state.';

// Compact 8-char fixed-width name column tail — visually anchors the log
// timestamp. Wider rows would push the message off-screen on narrow
// terminals while still under-utilizing the row's real estate.
const NAME_WIDTH = 32;
const STATUS_WIDTH = 11;
// Synthetic group for entries whose key doesn't carry a `<group>.<name>`
// prefix (`wallet`, `manifest`, `dev-server`, …). Renders last so the
// primary plugin sections (Sui, Accounts, Publish, …) anchor the top.
const UNGROUPED = 'Other';
// Two-layer truncation defense:
//   1. `MAX_DETAIL_LEN` — character-cap the string before ink lays it out
//      so a 4KB docker-pull stderr can't dominate the row's flex slot
//      even on a wide terminal.
//   2. `<Text wrap='truncate-end'>` — ink-side fallback that clips any
//      remaining overflow inside the column width, preventing a single
//      cell from wrapping onto a second line and breaking row alignment.
// 60 chars keeps the detail cell readable on narrow terminals; the full
// text is always reachable via the global log tail directly below.
const MAX_DETAIL_LEN = 60;
// Last N global log entries shown under the table — beyond that the user
// has the full scrollback above and `manifest.json` for structured
// access.

const STATUS_GLYPH: Record<TagStatus, string> = {
	pending: '·',
	acquiring: '⊙',
	ready: '✓',
	failed: '✗',
	// Teardown glyphs — ⊘ "in progress" and ⊠ "terminated". Dim greys
	// (set below) keep them visually subordinate to live rows.
	stopping: '⊘',
	stopped: '⊠',
};

const STATUS_COLOR: Record<TagStatus, string | undefined> = {
	pending: undefined,
	acquiring: 'cyan',
	ready: 'green',
	failed: 'red',
	// Yellow while in-flight, grey once done — matches the BUILD_STATUS_COLOR
	// 'shutting-down' tint for visual continuity with the header.
	stopping: 'yellow',
	stopped: undefined,
};

const BUILD_STATUS_COLOR: Record<BuildStatus, string | undefined> = {
	idle: undefined,
	running: 'cyan',
	failed: 'red',
	restarting: 'yellow',
	'shutting-down': 'yellow',
};

// Per-section/per-source color so the eye can scan which lines come
// from which service without re-reading every label. Used for the section
// headers (`services`, `packages`, …) and log-line source prefixes — both
// of those are group-name driven. Plugin-colored row chips use the
// separate `pluginColor()` map below.
// `red` deliberately omitted: the `failed` status badge is rendered
// red, and a section heading also tinted red would mislead the eye
// into reading the section as failed when only one row inside is.
const SECTION_COLORS: ReadonlyArray<string> = [
	'cyan',
	'green',
	'yellow',
	'magenta',
	'blue',
	'cyanBright',
	'greenBright',
];
const SECTION_COLOR_CACHE = new Map<string, string>();
const sectionColor = (group: string): string => {
	const key = group.toLowerCase();
	const cached = SECTION_COLOR_CACHE.get(key);
	if (cached !== undefined) return cached;
	// FNV-1a-ish 32-bit hash so the same group name always lands on the
	// same color across runs and across the TUI vs the log lines.
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h = (h ^ key.charCodeAt(i)) >>> 0;
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	const color = SECTION_COLORS[h % SECTION_COLORS.length] ?? 'magenta';
	SECTION_COLOR_CACHE.set(key, color);
	return color;
};

// Predefined plugin→color map for in-tree services. The user learns the
// legend once ("blue = walrus") and it stays consistent across runs,
// across stacks, and across examples. Out-of-tree plugins fall back to a
// name-hash against the same palette so they still get a stable color,
// just not a memorable one. The ordering also drives same-plugin row
// adjacency in `GroupSection` — services within a section render in
// PLUGIN_ORDER first, then by their original config-position.
const PLUGIN_COLOR_MAP: ReadonlyMap<string, string> = new Map([
	['sui', 'cyan'],
	['walrus', 'blue'],
	['seal', 'magenta'],
	['deepbook', 'green'],
	['coin', 'yellow'],
	['wallet', 'cyanBright'],
	['move', 'greenBright'],
	['codegen', 'greenBright'],
	['pyth', 'magenta'],
	['postgres', 'blue'],
	// Generic primitives keep colors but no strong identity. They tend to
	// share sections rather than dominate them.
	['account', 'yellow'],
	['action', 'yellow'],
	['dev', 'cyan'],
]);
const PLUGIN_ORDER: ReadonlyMap<string, number> = new Map(
	Array.from(PLUGIN_COLOR_MAP.keys()).map((p, i) => [p, i]),
);
const PLUGIN_COLOR_CACHE = new Map<string, string>();
const pluginColor = (plugin: string): string => {
	const key = plugin.toLowerCase();
	const fromMap = PLUGIN_COLOR_MAP.get(key);
	if (fromMap !== undefined) return fromMap;
	const cached = PLUGIN_COLOR_CACHE.get(key);
	if (cached !== undefined) return cached;
	// Same FNV-1a hash as sectionColor so an external plugin's color is
	// stable across runs. Hash the plugin name (not group name) so an
	// out-of-tree plugin with multiple services keeps a consistent color
	// across its own rows.
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h = (h ^ key.charCodeAt(i)) >>> 0;
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	const color = SECTION_COLORS[h % SECTION_COLORS.length] ?? 'magenta';
	PLUGIN_COLOR_CACHE.set(key, color);
	return color;
};

const formatTime = (ts: number): string => {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
};

const levelColor = (level: string): string | undefined => {
	switch (level.toLowerCase()) {
		case 'error':
		case 'fatal':
			return 'red';
		case 'warn':
		case 'warning':
			return 'yellow';
		case 'info':
			return 'cyan';
		default:
			return undefined;
	}
};

// 'done' for completed actions reads better than 'ready' (it's a one-shot).
//
// While `acquiring`, the status column reflects WHAT the primitive is doing
// (`building`, `starting`, `waiting`, …) rather than the abstract
// lifecycle word "acquiring" — "acquiring" reads as if something is being
// downloaded, but most phases are container/probe/cli work. The mapping
// derives a single verb from the phase string; an unknown phase falls
// through to its first word so a new primitive's narration surfaces
// without code changes. With no phase set we default to "starting" — the
// abstract lifecycle word should still be in motion, not a noun.
const PHASE_STATUS_OVERRIDES: ReadonlyMap<string, string> = new Map([
	['awaiting rpc + faucet + graphql', 'waiting'],
	['awaiting ready', 'waiting'],
	['requesting funds', 'funding'],
]);

const phraseStatusWord = (phase: string): string => {
	const override = PHASE_STATUS_OVERRIDES.get(phase);
	if (override !== undefined) return override;
	const first = phase.trim().split(/\s+/)[0] ?? phase;
	return first.length > 0 ? first : 'starting';
};

const statusWord = (entry: TuiEntry): string => {
	// "ready" only applies to live primitives the user can dial (services
	// with running processes/containers/sockets). Everything else — accounts
	// that produced an address, packages that published a packageId, actions
	// that executed a tx, codegen that emitted files, the manifest sidecar
	// — is one-shot work that COMPLETED, not a live thing standing by.
	// "done" reads as "this is finished", which matches what's actually true
	// for those rows. Previously only `action` got the "done" word; widening
	// to the full set of one-shot kinds.
	if (entry.status === 'ready' && entry.kind !== 'service') return 'done';
	if (entry.status === 'acquiring') {
		return entry.phase !== undefined && entry.phase.length > 0
			? phraseStatusWord(entry.phase)
			: 'starting';
	}
	return entry.status;
};

// `@devstack/<name>` namespace is purely a key disambiguator; the dashboard
// title is the user-facing label provided by the primitive's `display`
// selector. When neither's available, surface the bare key minus the
// internal prefix.
const entryTitle = (e: TuiEntry): string => {
	if (e.title !== undefined && e.title.length > 0) return e.title;
	return e.key.startsWith('@devstack/') ? e.key.slice('@devstack/'.length) : e.key;
};

// Display titles follow `<group>.<name>` convention (`sui.localnet`,
// `accounts.alice`, `publish.connect_four`). Split on the first dot for
// grouping; everything else lands in the `UNGROUPED` bucket. The leading
// `@devstack/` namespace is dropped before the split so an interface tag
// key like `@devstack/Sui` doesn't pollute the group label.
interface ParsedTitle {
	readonly group: string;
	readonly name: string;
}
const parseTitle = (raw: string): ParsedTitle => {
	const stripped = raw.startsWith('@devstack/') ? raw.slice('@devstack/'.length) : raw;
	const dot = stripped.indexOf('.');
	if (dot <= 0) return { group: UNGROUPED, name: stripped };
	return { group: stripped.slice(0, dot), name: stripped.slice(dot + 1) };
};

// Title-case the group label so the section header reads like a noun
// (`Sui`, `Accounts`, `Publish`) rather than a lowercase identifier.
const headerLabel = (group: string): string => {
	if (group.length === 0) return group;
	return group.charAt(0).toUpperCase() + group.slice(1);
};

// Truncate the detail-column text. Errors and long log lines blow past the
// row's allocated flex slot otherwise; the full text lives in the global
// log tail directly below.
const truncate = (s: string, max = MAX_DETAIL_LEN): string => {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
};

// Detail-column resolution order:
//   1. error      — the user's blocking concern, render in red.
//   2. lastLog    — most recent narration for this primitive.
//   3. primary    — the resolved artifact (URL / packageId / digest).
//   4. extras     — secondary chips.
// `phase` is intentionally not a detail candidate: it's promoted to the
// status column (`statusWord`) so a multi-step primitive surfaces what
// it's doing without consuming the row's detail budget.
// Returns `null` to render the cell empty (e.g. a pending tag).
interface Detail {
	readonly text: string;
	readonly color?: string;
	readonly dim?: boolean;
}

const resolveDetail = (entry: TuiEntry): Detail | null => {
	if (entry.error !== undefined && entry.status === 'failed') {
		return { text: truncate(entry.error), color: 'red' };
	}
	if (entry.lastLog !== undefined && entry.lastLog.length > 0) {
		return { text: truncate(entry.lastLog), dim: true };
	}
	// While acquiring, fall through to the FULL phase string so the
	// detail column surfaces what's happening. The status column only
	// shows the first word (`deploying`, `starting`, `waiting`); without
	// the full phase, a primitive that sits in "starting" for a minute
	// reads as hung. The full phase lives in the detail slot only when
	// nothing else (`lastLog`, `primary`) is competing for it.
	if (entry.status === 'acquiring' && entry.phase !== undefined && entry.phase.length > 0) {
		return { text: truncate(entry.phase), dim: true };
	}
	// Multi-endpoint primitives (sui's rpc/faucet/graphql) render the
	// FIRST endpoint inline in the detail column so the row reads the
	// same width as single-URL rows; continuation endpoints are rendered
	// as additional rows in `NodeRow` aligned under the detail column
	// (see the `restEndpoints` block there). Keeps the per-endpoint
	// label visible without breaking the row-per-primitive scan.
	if (entry.endpoints !== undefined && entry.endpoints.length > 0) {
		const first = entry.endpoints[0]!;
		return { text: `${first.label}  ${first.url}`, color: 'cyan' };
	}
	if (entry.primary !== undefined && entry.primary.length > 0) {
		const extras =
			entry.extras !== undefined && entry.extras.length > 0 ? ` (${entry.extras.join(', ')})` : '';
		// Don't truncate — IDs (packageId, address, digest) and URLs are
		// load-bearing for copy-paste. The `<Text wrap='wrap'>` in NodeRow
		// flows overflow onto a second line in the detail column rather
		// than clipping with `…`.
		return { text: `${entry.primary}${extras}`, color: 'cyan' };
	}
	if (entry.extras !== undefined && entry.extras.length > 0) {
		return { text: truncate(`(${entry.extras.join(', ')})`), dim: true };
	}
	return null;
};

export interface AppProps {
	readonly engine: EngineHandleShape;
	readonly onQuit: () => void;
	/** Synchronous "flush the engine's tuiState into the rendered tree
	 *  before the next event-loop turn" hook. The TUI mount in
	 *  `tui/index.ts` wires this to its `flush` Effect so the q-handler
	 *  can land the final 'shutting-down' frame on screen without the
	 *  prior hardcoded 150ms sleep. Optional so the ink-testing-library
	 *  tests can call `<App>` without a mount. */
	readonly onFlush?: () => void;
	/** Poll cadence for the engine's TuiState Ref. Lower in tests to
	 *  drive deterministic snapshots without burning real time. */
	readonly pollIntervalMs?: number;
}

// Polls `engine.tuiState` rather than subscribing to a Stream: the engine
// exposes a plain `Ref` (not a SubscriptionRef), and a 100ms tick is
// already faster than the eye can perceive flicker.
export function App(props: AppProps): React.ReactElement {
	const [state, setState] = useState<TuiState>(emptyState);
	const pollIntervalMs = props.pollIntervalMs ?? 100;

	useEffect(() => {
		// Reference-equality short-circuit: the engine mints a fresh
		// TuiState object on every mutation (`Ref.update` returns a
		// `{...s, ...}` spread), so `prev === next` is an accurate
		// "did anything change" check. Without this guard React was
		// scheduling a rerender 10×/sec on a quiet stack even though
		// the Ref hadn't moved.
		const apply = (next: TuiState): void => setState((prev) => (prev === next ? prev : next));
		Effect.runPromise(Ref.get(props.engine.tuiState))
			.then(apply)
			.catch(() => {});
		const interval = setInterval(() => {
			Effect.runPromise(Ref.get(props.engine.tuiState))
				.then(apply)
				.catch(() => {});
		}, pollIntervalMs);
		return () => clearInterval(interval);
	}, [props.engine, pollIntervalMs]);

	useInput((input, key) => {
		if (input === 'q' || input === 'Q') {
			// Flash the shutdown status + log line, then ask the supervisor
			// to shut down via the in-process `requestShutdown` signal.
			// Previously this called `process.kill(process.pid, 'SIGINT')`
			// to drive shutdown through NodeRuntime.runMain's signal
			// handler, but that lost a race with `inkApp.exit()`'s stdin
			// detach in practice — the SIGINT would arrive but the
			// supervisor's interruptible await had already moved past the
			// scheduling boundary, so the loop stayed parked at
			// `awaitRestart` and only a real terminal Ctrl-C (which sends
			// SIGINT to the foreground process group) could unwedge it.
			// `requestShutdown` is a Deferred the supervisor races against
			// `awaitRestart`; when it fires, the launch loop returns
			// cleanly and the outer Effect.scoped tears down all
			// finalizers. `inkApp.exit()` stays so the terminal restores
			// to a normal prompt while finalizers run in the background.
			Effect.runFork(
				Effect.gen(function* () {
					yield* props.engine.setBuildStatus('shutting-down');
					yield* props.engine.appendLog({
						ts: Date.now(),
						level: 'info',
						message: SHUTDOWN_LOG_MESSAGE,
					});
					yield* props.engine.requestShutdown;
				}).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							if (props.onFlush !== undefined) props.onFlush();
							props.onQuit();
						}),
					),
				),
			);
			return;
		}
		if (input === 'r' || input === 'R') {
			// Both `r` and `R` trigger a full restart today. Per-primitive
			// retry-failed would need a per-primitive scope architecture
			// that we rolled back.
			Effect.runFork(props.engine.requestRestart);
			return;
		}
		// Ctrl-C / Ctrl-D — `exitOnCtrlC` is off so we re-emit SIGINT and
		// let `NodeRuntime.runMain` drive the same teardown path a real
		// terminal Ctrl-C would.
		if (key.ctrl && (input === 'c' || input === 'd')) {
			process.kill(process.pid, 'SIGINT');
		}
	});

	// `<Static>` renders log entries above the live region and freezes
	// each one into the terminal scrollback — exactly the test-runner /
	// pnpm-install pattern (streaming output above, status pinned below).
	// Each log gets a stable `${ts}-${i}` id so Ink only re-renders new
	// entries, never existing ones.
	const staticLogs = state.logs.map((log, i) => ({ id: `${log.ts}-${i}`, log }));

	return (
		<>
			<Static items={staticLogs}>{({ id, log }) => <LogLine key={id} log={log} />}</Static>
			<Box flexDirection="column">
				<Header header={state.header} />
				<NodeTable entries={state.entries} />
				<Footer header={state.header} entries={state.entries} />
			</Box>
		</>
	);
}

function Header({ header }: { readonly header: TuiHeader }): React.ReactElement {
	const network =
		header.network === 'localnet' ? `localnet (stack=${header.stack})` : header.network;
	const buildColor = BUILD_STATUS_COLOR[header.buildStatus];
	return (
		<Box paddingX={1} borderStyle="round" borderColor="gray">
			<Text bold>{header.app || 'devstack'}</Text>
			<Text> · </Text>
			<Text>{network}</Text>
			<Text> · </Text>
			<Text dimColor>cycle {header.cycle}</Text>
			<Text> </Text>
			<Text color={buildColor ?? 'gray'}>[{header.buildStatus}]</Text>
		</Box>
	);
}

function NodeTable({ entries }: { readonly entries: ReadonlyArray<TuiEntry> }): React.ReactElement {
	if (entries.length === 0) {
		return (
			<Box paddingX={1}>
				<Text dimColor>no primitives in stack</Text>
			</Box>
		);
	}
	// Group rows by section. Each Ref factory stamps `__kind` (mapped to
	// TuiEntry.kind) with one of: service, package, account, action, app.
	// The fixed `SECTION_ORDER` below drives the visual order — services
	// first (URLs the user dials), then artifacts (packages, accounts),
	// then transactions, then the user's own app surface. Entries with
	// `kind: 'other'` fall back to the `parseTitle` heuristic so
	// hand-rolled refs (no `__kind`) still render under a recognizable label.
	const SECTION_ORDER: ReadonlyArray<TuiEntryKindLabel> = [
		'service',
		'package',
		'account',
		'action',
		'app',
	];
	const SECTION_HEADER: Record<TuiEntryKindLabel, string> = {
		service: 'services',
		package: 'packages',
		account: 'accounts',
		action: 'actions',
		app: 'app',
	};
	const buckets = new Map<string, Array<TuiEntry>>();
	const bucketOrder: Array<string> = [];
	const pushBucket = (key: string, entry: TuiEntry) => {
		if (!buckets.has(key)) {
			buckets.set(key, []);
			bucketOrder.push(key);
		}
		buckets.get(key)!.push(entry);
	};
	// First pass: stamp every entry with section-aware bucket. Sectioned
	// entries land in the fixed-order buckets; unsectioned fall back to
	// parseTitle so an 'Other' / legacy entry doesn't get lost.
	for (const section of SECTION_ORDER) {
		for (const entry of entries) {
			if (entry.kind === section) pushBucket(SECTION_HEADER[section], entry);
		}
	}
	// Second pass: 'other' entries (refs with no `__kind`) grouped by
	// parseTitle's display prefix, or the synthetic UNGROUPED bucket.
	for (const entry of entries) {
		if (SECTION_ORDER.includes(entry.kind as TuiEntryKindLabel)) continue;
		const { group } = parseTitle(entryTitle(entry));
		pushBucket(group, entry);
	}
	return (
		<Box flexDirection="column" paddingX={1}>
			{bucketOrder.map((group) => (
				<GroupSection key={group} label={group} entries={buckets.get(group) ?? []} />
			))}
		</Box>
	);
}

// Sections whose `ready` rows we fold into a single compact summary line
// (the bulk of a steady-state stack's clutter). Failed / in-flight rows
// still render as full rows so the user can see what's happening. We
// only fold when there are enough done rows for the saving to be worth
// the loss of per-row detail (the resolved primary/extras still live in
// the global log buffer and `manifest.json`).
const COLLAPSED_SECTIONS: ReadonlySet<string> = new Set(['actions']);
const COLLAPSE_THRESHOLD = 2;

// Sort within a section so same-plugin rows are visually adjacent. Plugin
// order = PLUGIN_ORDER ranking (sui < walrus < seal < …), with unknown
// plugins after known and undefined-plugin entries last. Within a plugin,
// preserve input order so an author's config-position is the tiebreaker.
const sortByPlugin = (entries: ReadonlyArray<TuiEntry>): ReadonlyArray<TuiEntry> => {
	const positioned = entries.map((entry, position) => ({ entry, position }));
	positioned.sort((a, b) => {
		const ap = a.entry.plugin?.toLowerCase();
		const bp = b.entry.plugin?.toLowerCase();
		if (ap === bp) return a.position - b.position;
		if (ap === undefined) return 1;
		if (bp === undefined) return -1;
		const ar = PLUGIN_ORDER.get(ap) ?? Number.MAX_SAFE_INTEGER;
		const br = PLUGIN_ORDER.get(bp) ?? Number.MAX_SAFE_INTEGER;
		if (ar !== br) return ar - br;
		// Both unknown to the predefined map: lexical so external plugins
		// at least cluster consistently.
		return ap < bp ? -1 : ap > bp ? 1 : a.position - b.position;
	});
	return positioned.map((p) => p.entry);
};

function GroupSection({
	label,
	entries,
}: {
	readonly label: string;
	readonly entries: ReadonlyArray<TuiEntry>;
}): React.ReactElement {
	const headerColor = sectionColor(label);
	const collapsible = COLLAPSED_SECTIONS.has(label);
	// Rows with endpoints are excluded from the collapse pool — a
	// multi-endpoint primitive (walrus aggregator/publisher; future
	// seal multi-server) needs its endpoint detail visible at all
	// times. Folding them into the `(N) ready` summary would hide
	// the URL the user actually needs.
	const hasVisibleEndpoints = (e: TuiEntry): boolean =>
		e.endpoints !== undefined && e.endpoints.length > 0;
	// Same-plugin adjacency: applied per-section so sui's rows cluster, then
	// walrus's, etc. Done BEFORE the ready/others split so the action-fold
	// collapse still operates on a consistent ordering.
	const sortedEntries = sortByPlugin(entries);
	const ready = collapsible
		? sortedEntries.filter((e) => e.status === 'ready' && !hasVisibleEndpoints(e))
		: [];
	const others = collapsible
		? sortedEntries.filter((e) => e.status !== 'ready' || hasVisibleEndpoints(e))
		: sortedEntries;
	const shouldCollapse = collapsible && ready.length > COLLAPSE_THRESHOLD;
	return (
		<Box flexDirection="column">
			<Text bold color={headerColor}>
				{headerLabel(label)}
			</Text>
			{others.map((e) => (
				<NodeRow key={e.key} entry={e} />
			))}
			{shouldCollapse ? (
				<CollapsedReadyRow entries={ready} />
			) : (
				ready.map((e) => <NodeRow key={e.key} entry={e} />)
			)}
		</Box>
	);
}

// Compact one-line replacement for a run of `ready` rows. Uses the same
// glyph + status word as a full row so the eye reads it as a single
// done-row; the names list keeps each primitive identifiable without
// consuming N lines of vertical space.
function CollapsedReadyRow({
	entries,
}: {
	readonly entries: ReadonlyArray<TuiEntry>;
}): React.ReactElement {
	// Sample the action status word — for the actions section this reads
	// `done`; for any future section we wire into the collapse mechanism
	// it falls back to `ready` per `statusWord`.
	const sample = entries[0]!;
	const word = statusWord(sample);
	const color = STATUS_COLOR.ready;
	const glyph = STATUS_GLYPH.ready;
	const names = entries.map((e) => parseTitle(entryTitle(e)).name).join(', ');
	return (
		<Box>
			<Box width={1}>
				<Text> </Text>
			</Box>
			<Box width={3}>
				<Text color={color}>{glyph}</Text>
			</Box>
			<Box width={NAME_WIDTH}>
				<Text dimColor>{`${word} (${entries.length})`}</Text>
			</Box>
			<Box flexGrow={1}>
				<Text dimColor wrap="wrap">
					{names}
				</Text>
			</Box>
		</Box>
	);
}

function NodeRow({ entry }: { readonly entry: TuiEntry }): React.ReactElement {
	const glyph = STATUS_GLYPH[entry.status];
	const color = STATUS_COLOR[entry.status];
	// `endpoints`-bearing primitives now render their URLs joined into the
	// detail column (see `resolveDetail`) — inline with the rest of the
	// dashboard's single-URL layout. The previous design rendered each
	// endpoint on its own indented sub-line below the row, which broke
	// the row-per-primitive scannability and ate vertical space; with the
	// joined-detail approach NodeRow no longer needs a separate sub-line
	// block, and the layout stays uniform across single-URL and
	// multi-URL rows.
	const detail = resolveDetail(entry);
	const { name } = parseTitle(entryTitle(entry));
	// Plugin chip: `[<plugin>]` in the plugin's color, between the status
	// glyph and the row name. Same-plugin rows share a color the user can
	// learn ("blue = walrus"); out-of-tree plugins get a stable hash-derived
	// color. Plugin-less rows skip the chip entirely so the layout doesn't
	// reserve dead space for entries without attribution.
	const chip = entry.plugin !== undefined ? `[${entry.plugin}] ` : '';
	const chipColor = entry.plugin !== undefined ? pluginColor(entry.plugin) : undefined;
	// Selective-restart hook: when this row is in the affected set of a
	// watch-driven cascade AND it's mid-re-acquire, render the status word
	// in `inverse` so the eye can trace which rows are flipping vs. the
	// rest of the dashboard (which keeps its `ready` glyphs steady). Once
	// the row reaches `ready` the engine clears `selectiveRestart` and the
	// inverse fades — the per-row "did this restart fire because of MY
	// edit?" question is answerable at a glance. Distinct from
	// full-rebuild `r`: that route doesn't set `selectiveRestart`, so
	// every row stays in plain-color `acquiring`.
	const selective = entry.selectiveRestart === true && entry.status === 'acquiring';
	// Continuation rows for multi-endpoint primitives (sui's rpc/faucet/
	// graphql). `resolveDetail` puts endpoint #0 inline in the detail
	// column; #1+ render here, aligned UNDER the detail column so the
	// per-endpoint label/url pairs line up with the first endpoint
	// (instead of running off the left margin). Endpoint width matches
	// the row's left prefix (1 + 3 + NAME_WIDTH + STATUS_WIDTH).
	const restEndpoints =
		entry.endpoints !== undefined && entry.endpoints.length > 1
			? entry.endpoints.slice(1)
			: undefined;
	const DETAIL_COLUMN_INDENT = 1 + 3 + NAME_WIDTH + STATUS_WIDTH;
	return (
		<Box flexDirection="column">
			<Box>
				<Box width={1}>
					<Text> </Text>
				</Box>
				<Box width={3}>
					<Text color={color}>{glyph}</Text>
				</Box>
				<Box width={NAME_WIDTH}>
					{chip.length > 0 ? <Text color={chipColor}>{chip}</Text> : null}
					<Text>{name}</Text>
				</Box>
				<Box width={STATUS_WIDTH}>
					<Text color={color} dimColor={entry.status === 'pending'} inverse={selective}>
						{statusWord(entry)}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{detail !== null ? (
						detail.color !== undefined ? (
							// Full IDs/URLs in `primary` may exceed the row width;
							// wrap rather than truncate so the user can still read
							// + copy the trailing characters.
							<Text color={detail.color} wrap="wrap">
								{detail.text}
							</Text>
						) : (
							<Text dimColor={detail.dim === true} wrap="wrap">
								{detail.text}
							</Text>
						)
					) : null}
				</Box>
			</Box>
			{restEndpoints !== undefined
				? restEndpoints.map((ep) => (
						<Box key={ep.label}>
							<Box width={DETAIL_COLUMN_INDENT}>
								<Text> </Text>
							</Box>
							<Box flexGrow={1}>
								<Text color="cyan" wrap="wrap">
									{`${ep.label}  ${ep.url}`}
								</Text>
							</Box>
						</Box>
					))
				: null}
		</Box>
	);
}

// Log lines from `withEngineLifecycle` and friends are formatted as
// `<service>: <message>` (e.g. `@devstack/Sui: …`, `walrusLocalCluster:
// …`). Pull the source prefix out so we can tint each line by the same
// section color the row above uses — makes "which service emitted this
// log" scannable at a glance.
const SOURCE_PREFIX_RE = /^(@devstack\/)?([A-Za-z0-9_\-./]+?):\s+/;
const parseLogSource = (
	message: string,
): { readonly source: string | undefined; readonly rest: string } => {
	const match = SOURCE_PREFIX_RE.exec(message);
	if (match === null) return { source: undefined, rest: message };
	const raw = match[2] ?? '';
	if (raw.length === 0) return { source: undefined, rest: message };
	// Drop the `@devstack/`-style namespace prefix the engine sometimes
	// attaches, and split on `.` so `walrus.deploy` / `walrusLocalCluster`
	// both fold into a section color.
	const stripped = raw.startsWith('@devstack/') ? raw.slice('@devstack/'.length) : raw;
	const groupKey = stripped.split('.')[0] ?? stripped;
	return { source: groupKey, rest: message.slice(match[0].length) };
};

// Cap on how many continuation lines a single log entry can render in
// the TUI panel. A walrus storage-node dumping its StorageNodeConfig
// (~200 lines of nested Rust struct debug) or sui's checkpoint trace
// would otherwise push everything else off-screen on each emission.
// Errors that need the full body (the pretty-printed cause trees we
// added explicit support for) almost always fit in <12 lines; anything
// beyond that is debug-spam that belongs in `docker logs <container>`.
const MAX_LOG_CONTINUATION_LINES = 12;

// Per-line length cap for routine container logs (INFO/WARN). Walrus +
// sui dump structured JSON-per-line (`{"timestamp":…,"level":"INFO",
// "fields":{"message":"…huge config dump…"}, "target":"…"}`) that's
// useful for `docker logs` debugging but unreadable in a TUI strip.
// Capping at 240 chars keeps the most-recent N entries visible without
// requiring the user to scroll a single entry to read the next one.
// ERROR/FATAL stay uncapped so the UNCLEAN PRIOR SHUTDOWN body, faucet
// 500-with-payload responses, and stack-acquire-failed cause trees all
// surface in full — those are the lines the user MUST see.
const INFO_LOG_MAX_CHARS = 240;
const capInfoLine = (level: string, line: string): string => {
	const lvl = level.toLowerCase();
	if (lvl === 'error' || lvl === 'fatal') return line;
	if (line.length <= INFO_LOG_MAX_CHARS) return line;
	return `${line.slice(0, INFO_LOG_MAX_CHARS - 1)}…`;
};

function LogLine({ log }: { readonly log: TuiLog }): React.ReactElement {
	const color = levelColor(log.level);
	// Split on newlines so multi-line bodies (pretty-printed cause trees,
	// stack-acquire-failed dumps) render in full — fixing the
	// `.split('\n')[0]` truncation that silently dropped everything after
	// the first line. Continuation lines wrap via ink's `wrap='wrap'`
	// instead of the previous hard-truncate at 120 chars.
	//
	// Two caps applied:
	//  - Per-line chars (INFO_LOG_MAX_CHARS=240) for INFO/WARN to keep
	//    container JSON-log soup from dominating the panel. ERROR/FATAL
	//    stay uncapped so the actionable bits (recovery commands, full
	//    cause walks) stay readable.
	//  - Continuation count (MAX_LOG_CONTINUATION_LINES=12) so a verbose
	//    multi-line dump can't push everything else off-screen; surface
	//    the overflow count so the user knows there's more in `docker logs`.
	const lines = log.message.split('\n');
	const firstLine = lines[0] ?? log.message;
	const restLines = lines.slice(1);
	const visibleRest = restLines.slice(0, MAX_LOG_CONTINUATION_LINES);
	const hiddenLineCount = restLines.length - visibleRest.length;
	const { source, rest } = parseLogSource(firstLine);
	const srcColor = source !== undefined ? sectionColor(source) : undefined;
	const capLine = (s: string) => capInfoLine(log.level, s);
	// Continuation lines align under the message column ("HH:MM:SS " +
	// "LEVEL " = 15 chars) so they read as one entry instead of unanchored
	// continuation text.
	const indent = ' '.repeat(15);
	return (
		<Box flexDirection="column">
			<Box>
				<Text dimColor>{formatTime(log.ts)} </Text>
				{color !== undefined ? (
					<Text color={color}>{log.level.padEnd(5)} </Text>
				) : (
					<Text dimColor>{log.level.padEnd(5)} </Text>
				)}
				<Box flexGrow={1}>
					{source !== undefined && srcColor !== undefined ? (
						<>
							<Text color={srcColor}>{source}</Text>
							<Text dimColor>: </Text>
							<Text wrap="wrap">{capLine(rest)}</Text>
						</>
					) : (
						<Text wrap="wrap">{capLine(firstLine)}</Text>
					)}
				</Box>
			</Box>
			{visibleRest.map((line, i) => (
				<Box key={i}>
					<Text dimColor>{indent}</Text>
					<Box flexGrow={1}>
						{color !== undefined ? (
							<Text color={color} wrap="wrap">
								{capLine(line)}
							</Text>
						) : (
							<Text wrap="wrap">{capLine(line)}</Text>
						)}
					</Box>
				</Box>
			))}
			{hiddenLineCount > 0 ? (
				<Box>
					<Text dimColor>{indent}</Text>
					<Text dimColor>
						… {hiddenLineCount} more line{hiddenLineCount === 1 ? '' : 's'} suppressed
						(check `docker logs` for full output)
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

function Footer({
	header,
	entries,
}: {
	readonly header: TuiHeader;
	readonly entries: ReadonlyArray<TuiEntry>;
}): React.ReactElement {
	if (header.buildStatus === 'shutting-down') {
		// Pending = rows whose long-lived resource hasn't finished teardown
		// yet. We track this directly via the engine's `markStopping` /
		// `markStopped` hooks (fired by Docker.run's stop finalizer), so
		// the count decrements as docker confirms each container exit
		// instead of staying static for the whole teardown window. A row
		// in 'stopping' state still has work in flight; 'stopped' means
		// docker returned. Both are excluded from the count.
		const pending = entries.filter(
			(e) =>
				e.status === 'ready' &&
				(e.kind === 'service' || e.kind === 'package'),
		);
		// De-dupe the plugin list — multi-row plugins (e.g. walrus has 4
		// storage-node rows, sui has localnet + faucet rows) would otherwise
		// surface their plugin name N times, like
		// `(walrus, walrus, walrus, walrus, sui, sui)`. Dedupe in insertion
		// order so the same plugins always read the same way across cycles.
		const pluginsSeen = new Set<string>();
		const plugins: Array<string> = [];
		for (const e of pending) {
			const name = e.plugin ?? parseTitle(entryTitle(e)).group;
			if (!pluginsSeen.has(name)) {
				pluginsSeen.add(name);
				plugins.push(name);
			}
		}
		// "service" is honest (containers, host processes, action handlers
		// all surface as a TuiEntry with kind='service'); the previous
		// "container" copy lied for host processes (wallet, dev-server),
		// composite rows whose sub-containers map to docker (walrus
		// cluster), and shared-container rows (sui faucet served by
		// sui-localnet's container).
		const detail =
			pending.length === 0
				? 'releasing resources…'
				: `waiting on ${pending.length} service${pending.length === 1 ? '' : 's'}` +
					` from ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}` +
					` (${plugins.join(', ')})`;
		return (
			<Box paddingX={1} marginTop={1}>
				<Text color="yellow">Shutting down — </Text>
				<Text dimColor>{detail}</Text>
			</Box>
		);
	}
	return (
		<Box paddingX={1} marginTop={1}>
			<Text dimColor>[r]estart [q]uit Ctrl-C to exit</Text>
		</Box>
	);
}
