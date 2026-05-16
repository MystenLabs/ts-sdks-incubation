// Ink components for the devstack TUI.
//
// Layout: a rounded header bar, a single flat node table (one row per
// primitive, no Services/Actions sections), a compact log tail of recent
// globals, and a footer with the keybind hints. Ink owns all
// cursor/clear/diff plumbing so we don't hand-roll any ANSI; that
// responsibility moves entirely out of our codebase.

import { Box, Static, Text, useApp, useInput } from 'ink';
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
} from './render.js';

/** The five user-intent sections the TUI groups by. Excludes 'other',
 *  which is the catchall for legacy/hand-rolled refs that fall through
 *  to `parseTitle`'s display-prefix grouping. */
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
// Phase 4 vocabulary scrub: "container" disappears from user-visible copy;
// background-service framing replaces the docker-leaky "reusable containers"
// language. `devstack wipe --yes` remains the path to a full local reset.
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
};

const STATUS_COLOR: Record<TagStatus, string | undefined> = {
	pending: undefined,
	acquiring: 'cyan',
	ready: 'green',
	failed: 'red',
};

const BUILD_STATUS_COLOR: Record<BuildStatus, string | undefined> = {
	idle: undefined,
	running: 'cyan',
	failed: 'red',
	restarting: 'yellow',
	'shutting-down': 'yellow',
};

// Per-section/per-source color so the eye can scan which lines come
// from which service without re-reading every label. Stable mapping —
// keep in lockstep with the keys produced by `parseTitle`'s `<group>`.
// Unknown groups fall through to `magenta` so a new primitive still
// gets a distinct tint until it's added here.
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
	if (entry.status === 'ready' && entry.kind === 'action') return 'done';
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
	if (
		entry.status === 'acquiring' &&
		entry.phase !== undefined &&
		entry.phase.length > 0
	) {
		return { text: truncate(entry.phase), dim: true };
	}
	if (entry.primary !== undefined && entry.primary.length > 0) {
		const extras =
			entry.extras !== undefined && entry.extras.length > 0
				? ` (${entry.extras.join(', ')})`
				: '';
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
	/** Poll cadence for the engine's TuiState Ref. Lower in tests to
	 *  drive deterministic snapshots without burning real time. */
	readonly pollIntervalMs?: number;
}

// Polls `engine.tuiState` rather than subscribing to a Stream: the engine
// exposes a plain `Ref` (not a SubscriptionRef), and a 100ms tick is
// already faster than the eye can perceive flicker.
export function App(props: AppProps): React.ReactElement {
	const [state, setState] = useState<TuiState>(emptyState);
	const inkApp = useApp();
	const pollIntervalMs = props.pollIntervalMs ?? 100;

	useEffect(() => {
		Effect.runPromise(Ref.get(props.engine.tuiState)).then(setState).catch(() => {});
		const interval = setInterval(() => {
			Effect.runPromise(Ref.get(props.engine.tuiState))
				.then(setState)
				.catch(() => {});
		}, pollIntervalMs);
		return () => clearInterval(interval);
	}, [props.engine, pollIntervalMs]);

	useInput((input, key) => {
		if (input === 'q' || input === 'Q') {
			// Flash the shutdown status + log line BEFORE killing the
			// process: the scope-teardown finalizers (`docker rm -f`, etc.)
			// hold the event loop uninterruptibly, so without an explicit
			// pre-kill render tick the header freezes on `[running]` and
			// reads as a hang. The 150ms sleep is long enough for the
			// ink poll interval (default 100ms) to pick up the new state.
			Effect.runFork(
				Effect.gen(function* () {
					yield* props.engine.setBuildStatus('shutting-down');
					yield* props.engine.appendLog({
						ts: Date.now(),
						level: 'info',
						message: SHUTDOWN_LOG_MESSAGE,
					});
					yield* Effect.sleep('150 millis');
				}).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							props.onQuit();
							inkApp.exit();
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
			<Static items={staticLogs}>
				{({ id, log }) => <LogLine key={id} log={log} />}
			</Static>
			<Box flexDirection='column'>
				<Header header={state.header} />
				<NodeTable entries={state.entries} />
				<Footer />
			</Box>
		</>
	);
}

function Header({ header }: { readonly header: TuiHeader }): React.ReactElement {
	const network =
		header.network === 'localnet'
			? `localnet (stack=${header.stack})`
			: header.network;
	const buildColor = BUILD_STATUS_COLOR[header.buildStatus];
	return (
		<Box paddingX={1} borderStyle='round' borderColor='gray'>
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

function NodeTable({
	entries,
}: {
	readonly entries: ReadonlyArray<TuiEntry>;
}): React.ReactElement {
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
	// `kind: 'other'` fall back to the legacy `parseTitle` heuristic so
	// hand-rolled v3-style refs still render under a recognizable label.
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
	// Second pass: legacy 'other' entries grouped by parseTitle's display
	// prefix (or the synthetic UNGROUPED bucket).
	for (const entry of entries) {
		if (SECTION_ORDER.includes(entry.kind as TuiEntryKindLabel)) continue;
		const { group } = parseTitle(entryTitle(entry));
		pushBucket(group, entry);
	}
	return (
		<Box flexDirection='column' paddingX={1}>
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

function GroupSection({
	label,
	entries,
}: {
	readonly label: string;
	readonly entries: ReadonlyArray<TuiEntry>;
}): React.ReactElement {
	const headerColor = sectionColor(label);
	const collapsible = COLLAPSED_SECTIONS.has(label);
	const ready = collapsible ? entries.filter((e) => e.status === 'ready') : [];
	const others = collapsible ? entries.filter((e) => e.status !== 'ready') : entries;
	const shouldCollapse = collapsible && ready.length > COLLAPSE_THRESHOLD;
	return (
		<Box flexDirection='column'>
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
				<Text dimColor wrap='wrap'>
					{names}
				</Text>
			</Box>
		</Box>
	);
}

function NodeRow({ entry }: { readonly entry: TuiEntry }): React.ReactElement {
	const glyph = STATUS_GLYPH[entry.status];
	const color = STATUS_COLOR[entry.status];
	// `endpoints`-bearing rows render the URLs on dedicated indented lines
	// below the row; the detail column is suppressed to avoid duplicating
	// the same URL. Failure rows still resolve `detail` from `error` so the
	// short failure summary lands on the row even when endpoints were
	// previously populated.
	const detail =
		entry.endpoints !== undefined && entry.endpoints.length > 0 && entry.status !== 'failed'
			? null
			: resolveDetail(entry);
	const { name } = parseTitle(entryTitle(entry));
	return (
		<Box flexDirection='column'>
			<Box>
				<Box width={1}>
					<Text> </Text>
				</Box>
				<Box width={3}>
					<Text color={color}>{glyph}</Text>
				</Box>
				<Box width={NAME_WIDTH}>
					<Text>{name}</Text>
				</Box>
				<Box width={STATUS_WIDTH}>
					<Text color={color} dimColor={entry.status === 'pending'}>
						{statusWord(entry)}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{detail !== null ? (
						detail.color !== undefined ? (
							// Full IDs/URLs in `primary` may exceed the row width;
							// wrap rather than truncate so the user can still read
							// + copy the trailing characters.
							<Text color={detail.color} wrap='wrap'>
								{detail.text}
							</Text>
						) : (
							<Text dimColor={detail.dim === true} wrap='wrap'>
								{detail.text}
							</Text>
						)
					) : null}
				</Box>
			</Box>
			{entry.endpoints !== undefined && entry.endpoints.length > 0
				? entry.endpoints.map((ep) => {
						// Labelled tree below the row: ` • <label>  <url>`.
						// Label column is fixed width so URLs line up across
						// endpoints. The bullet is dim grey so the row glyph
						// (✓ / ✗ / ⊙) stays visually dominant.
						const labelWidth = Math.max(
							8,
							...(entry.endpoints ?? []).map((e) => e.label.length),
						);
						return (
							<Box key={ep.label} paddingLeft={4 + 3 + 1}>
								<Box width={2}>
									<Text dimColor>•</Text>
								</Box>
								<Box width={labelWidth + 2}>
									<Text dimColor>{ep.label}</Text>
								</Box>
								<Text color='cyan' wrap='wrap'>
									{ep.url}
								</Text>
							</Box>
						);
					})
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

function LogLine({ log }: { readonly log: TuiLog }): React.ReactElement {
	const color = levelColor(log.level);
	const firstLine = log.message.split('\n')[0] ?? log.message;
	const { source, rest } = parseLogSource(firstLine);
	const srcColor = source !== undefined ? sectionColor(source) : undefined;
	return (
		<Text>
			<Text dimColor>{formatTime(log.ts)}</Text>
			<Text> </Text>
			{color !== undefined ? (
				<Text color={color}>{log.level.padEnd(5)}</Text>
			) : (
				<Text dimColor>{log.level.padEnd(5)}</Text>
			)}
			<Text> </Text>
			{source !== undefined && srcColor !== undefined ? (
				<>
					<Text color={srcColor}>{source}</Text>
					<Text dimColor>: </Text>
					<Text>{truncate(rest, 120)}</Text>
				</>
			) : (
				<Text>{truncate(firstLine, 120)}</Text>
			)}
		</Text>
	);
}

function Footer(): React.ReactElement {
	return (
		<Box paddingX={1} marginTop={1}>
			<Text dimColor>[r]estart  [q]uit  Ctrl-C to exit</Text>
		</Box>
	);
}
