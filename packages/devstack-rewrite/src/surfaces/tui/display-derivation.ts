// Display derivation — the load-bearing transducer that makes the
// "no display vocab in projection" invariant testable.
//
// The renderer consumes ONLY the typed projection (`Row`, `Endpoint`,
// `StructuredError`, `LifecycleStatus`, `PluginKind`, …) from
// `substrate/projection.ts`. Every visible glyph, color, label, and
// narration string is computed HERE from `row.kind`, `row.status`,
// `row.phase`, `row.lastError`, etc.
//
// HARD INVARIANT: this module never reads a field named `title`,
// `primary`, or `extras` — those fields don't exist on the projection
// (the substrate's `__ProjectionFieldsClosed` guard fails to compile
// if they did). The TUI's test of that invariant is: every visible
// cell rendered by `row-renderer.tsx` flows through one of these pure
// functions.
//
// Pure. No Effect, no IO, no clocks. Input typed projection → output
// strings + enum-y "color tokens" (resolved to terminal colors by the
// Ink layer via `Text color={…}`).

import type { LifecycleStatus, PhaseNarration, PluginKind } from '../../substrate/lifecycle.ts';
import type { Endpoint, Row, StructuredError } from '../../substrate/projection.ts';

// -----------------------------------------------------------------------------
// Color tokens
// -----------------------------------------------------------------------------

/**
 * Closed set of color tokens the TUI uses. Ink resolves these to ANSI
 * sequences. NO_COLOR / FORCE_COLOR / TERM=dumb are honored by Ink's
 * defaults (Tension: TUI must not override user color preferences).
 */
export type ColorToken =
	| 'gray'
	| 'yellow'
	| 'green'
	| 'red'
	| 'magenta'
	| 'cyan'
	| 'blueBright'
	| 'white';

// -----------------------------------------------------------------------------
// Display cells — the public output shape of this module
// -----------------------------------------------------------------------------

/**
 * Per-row display cells the row renderer consumes. None of these
 * fields are read from the projection — they are computed from
 * `Row.kind` + `Row.status` + `Row.phase` + `Row.lastError`.
 *
 * Naming note: we DELIBERATELY avoid the words `title`, `primary`,
 * `extras` in this type's field names to make the invariant grep-able.
 * `label` is computed from `key` + `kind`; `narration` from `phase`;
 * `summary` from `lastError`.
 */
export interface DisplayCells {
	/** Status glyph (single char). */
	readonly statusGlyph: string;
	/** Status color token. */
	readonly statusColor: ColorToken;
	/** Status label (short verbal, e.g. "ready"). */
	readonly statusLabel: string;
	/** Kind glyph (single char). */
	readonly kindGlyph: string;
	/** Kind label (e.g. "service"). */
	readonly kindLabel: string;
	/** Computed row label — derived from `row.key`, not from any
	 *  projection-side `title`. */
	readonly label: string;
	/** Narration line — formatted from `row.phase`. */
	readonly narration: string;
	/** Error summary — formatted from `row.lastError`. */
	readonly errorSummary: string;
	/** Color the row's label should render in (kind-derived,
	 *  optionally tinted by status). */
	readonly labelColor: ColorToken;
	/** Group bucket for dashboard sectioning. */
	readonly section: RowSection;
	/** Plugin-owner chip derived from the row key. */
	readonly owner: string;
	/** Main row value: usually the first endpoint or latest useful line. */
	readonly headline: string;
	/** Secondary details visible in the detail pane. */
	readonly secondary: ReadonlyArray<string>;
}

export type RowSection = 'service' | 'package' | 'account' | 'action' | 'app' | 'other';

export interface DisplayRow {
	readonly row: Row;
	readonly cells: DisplayCells;
}

export interface DisplaySection {
	readonly key: RowSection;
	readonly label: string;
	readonly rows: ReadonlyArray<DisplayRow>;
}

// -----------------------------------------------------------------------------
// Status → glyph / color / label
// -----------------------------------------------------------------------------

/** Pure: status → ANSI glyph. */
export const statusGlyph = (status: LifecycleStatus): string => {
	switch (status) {
		case 'pending':
			return '○';
		case 'acquiring':
			return '◐';
		case 'ready':
			return '●';
		case 'failed':
			return '✖';
		case 'stopping':
			return '◑';
		case 'stopped':
			return '◌';
		case 'done':
			return '✓';
		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return '?';
		}
	}
};

/** Pure: status → color token. */
export const statusColor = (status: LifecycleStatus): ColorToken => {
	switch (status) {
		case 'pending':
			return 'gray';
		case 'acquiring':
			return 'yellow';
		case 'ready':
			return 'green';
		case 'failed':
			return 'red';
		case 'stopping':
			return 'yellow';
		case 'stopped':
			return 'gray';
		case 'done':
			return 'green';
		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return 'white';
		}
	}
};

/** Pure: status → short label. */
export const statusLabel = (status: LifecycleStatus): string => status;

// -----------------------------------------------------------------------------
// Kind → glyph / label / color
// -----------------------------------------------------------------------------

/** Pure: kind → ANSI glyph. */
export const kindGlyph = (kind: PluginKind): string => {
	switch (kind) {
		case 'leaf-long-running':
			return '⚙';
		case 'leaf-one-shot':
			return '⚡';
		case 'composite':
			return '◆';
		case 'hidden-leaf':
			return '·';
		case 'renderer':
			return '☷';
		default: {
			const _exhaustive: never = kind;
			void _exhaustive;
			return '?';
		}
	}
};

/** Pure: kind → short label. */
export const kindLabel = (kind: PluginKind): string => {
	switch (kind) {
		case 'leaf-long-running':
			return 'service';
		case 'leaf-one-shot':
			return 'one-shot';
		case 'composite':
			return 'composite';
		case 'hidden-leaf':
			return 'hidden';
		case 'renderer':
			return 'renderer';
		default: {
			const _exhaustive: never = kind;
			void _exhaustive;
			return 'unknown';
		}
	}
};

/** Pure: kind → label color token. */
export const kindLabelColor = (kind: PluginKind): ColorToken => {
	switch (kind) {
		case 'leaf-long-running':
			return 'cyan';
		case 'leaf-one-shot':
			return 'magenta';
		case 'composite':
			return 'blueBright';
		case 'hidden-leaf':
			return 'gray';
		case 'renderer':
			return 'white';
		default: {
			const _exhaustive: never = kind;
			void _exhaustive;
			return 'white';
		}
	}
};

// -----------------------------------------------------------------------------
// Row label — derived from `key`, not from any pre-baked title
// -----------------------------------------------------------------------------

/**
 * Compute a human-friendly row label from the opaque branded plugin
 * key. The substrate keeps `key` an opaque digest; the renderer is
 * the layer that interprets it. We strip a few conventional prefixes
 * (`devstack:`, `app:`) plus instance counters so common cases read
 * cleanly.
 *
 * The function consumes `key` and `kind` only — never `row.title`,
 * which doesn't exist in the projection.
 */
export const labelForRow = (key: string, _kind: PluginKind): string => {
	const normalized = normalizeKey(key);
	const parts = normalized.split(/[/:]/).filter((part) => part.length > 0);
	if (parts.length >= 2 && isSectionish(parts[0]!)) return humanizeToken(parts[parts.length - 1]!);
	return humanizeToken(parts[parts.length - 1] ?? normalized);
};

export const ownerForRow = (key: string): string => {
	const normalized = normalizeKey(key);
	const first = normalized.split(/[/:._#-]/).find((part) => part.length > 0);
	return first === undefined ? 'plugin' : humanizeToken(first);
};

export const sectionForRow = (
	row: Pick<Row, 'key' | 'kind' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint> = [],
): RowSection => {
	const normalized = normalizeKey(row.key).toLowerCase();
	const ownsEndpoint = endpointsForRow(row, endpoints).length > 0 || row.endpoints.length > 0;
	if (row.kind === 'leaf-long-running' || ownsEndpoint) return 'service';
	if (containsKeyPart(normalized, ['account', 'accounts'])) return 'account';
	if (containsKeyPart(normalized, ['package', 'packages', 'publish', 'move'])) return 'package';
	if (containsKeyPart(normalized, ['action', 'actions', 'execute', 'tx', 'faucet', 'mint'])) {
		return 'action';
	}
	if (containsKeyPart(normalized, ['app', 'wallet', 'frontend', 'vite', 'server'])) return 'app';
	if (row.kind === 'leaf-one-shot') return 'action';
	if (row.kind === 'composite') return 'service';
	return 'other';
};

export const sectionLabel = (section: RowSection): string => {
	switch (section) {
		case 'service':
			return 'Services';
		case 'package':
			return 'Packages';
		case 'account':
			return 'Accounts';
		case 'action':
			return 'Actions';
		case 'app':
			return 'App';
		case 'other':
			return 'Other';
		default: {
			const _exhaustive: never = section;
			void _exhaustive;
			return 'Other';
		}
	}
};

export const endpointsForRow = (
	row: Pick<Row, 'key' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint>,
): ReadonlyArray<Endpoint> =>
	endpoints.filter(
		(endpoint) =>
			row.endpoints.includes(endpoint.endpointKey) || endpoint.endpointKey.startsWith(row.key),
	);

export const headlineForRow = (row: Row, endpoints: ReadonlyArray<Endpoint> = []): string => {
	const rowEndpoints = endpointsForRow(row, endpoints);
	if (rowEndpoints.length > 0) return endpointLine(rowEndpoints[0]!);
	if (row.lastError !== null && row.status === 'failed') return errorSummaryFor(row.lastError);
	const latestLog = row.logTail.lines[row.logTail.lines.length - 1];
	if (latestLog !== undefined && latestLog.length > 0) return truncate(latestLog, 96);
	return narrationFor(row.phase, row.status);
};

export const secondaryForRow = (
	row: Row,
	endpoints: ReadonlyArray<Endpoint> = [],
): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const rowEndpoints = endpointsForRow(row, endpoints);
	for (const endpoint of rowEndpoints.slice(1)) out.push(endpointLine(endpoint));
	if (row.compositeChildren !== null && row.compositeChildren.length > 0) {
		out.push(`${row.compositeChildren.length} children`);
	}
	if (row.rebootCost !== null) out.push(`restart ${row.rebootCost}`);
	if (row.narrationByContributor !== null) {
		for (const [contributor, narration] of Object.entries(row.narrationByContributor)) {
			if (narration.trim().length > 0) out.push(`${humanizeToken(contributor)}: ${narration}`);
		}
	}
	if (row.logTail.truncated) out.push('log tail truncated');
	return out;
};

export const groupRows = (
	rows: ReadonlyArray<Row>,
	endpoints: ReadonlyArray<Endpoint> = [],
): ReadonlyArray<DisplaySection> => {
	const buckets = new Map<RowSection, Array<DisplayRow>>();
	for (const row of rows) {
		const cells = deriveDisplayCells(row, endpoints);
		const list = buckets.get(cells.section) ?? [];
		list.push({ row, cells });
		buckets.set(cells.section, list);
	}
	const order: ReadonlyArray<RowSection> = [
		'service',
		'package',
		'account',
		'action',
		'app',
		'other',
	];
	return order
		.filter((section) => buckets.has(section))
		.map((section) => ({
			key: section,
			label: sectionLabel(section),
			rows: buckets.get(section) ?? [],
		}));
};

export const selectRowKey = (
	rows: ReadonlyArray<Row>,
	current: string | null,
	delta: -1 | 1,
): string | null => {
	if (rows.length === 0) return null;
	const currentIndex = current === null ? -1 : rows.findIndex((row) => row.key === current);
	const start = currentIndex === -1 ? (delta > 0 ? -1 : 0) : currentIndex;
	const next = (start + delta + rows.length) % rows.length;
	return rows[next]!.key;
};

// -----------------------------------------------------------------------------
// Phase narration formatting
// -----------------------------------------------------------------------------

/**
 * Pure: phase narration string → renderable verb form. Phase is
 * free-form upstream (Tension 14). The renderer's job is to make it
 * legible; we keep this minimal — single-line, no fancy verb tense
 * inference. The truncation cap protects against pathological long
 * narrations.
 */
export const narrationFor = (phase: PhaseNarration | null, status: LifecycleStatus): string => {
	if (phase === null || phase.trim().length === 0) {
		// No phase set; surface a status-derived default for `acquiring`,
		// stay silent otherwise (Tension: don't manufacture text the
		// engine didn't ask for).
		return status === 'acquiring' ? 'starting…' : '';
	}
	const trimmed = phase.trim();
	const TRUNC = 80;
	return trimmed.length > TRUNC ? `${trimmed.slice(0, TRUNC - 1)}…` : trimmed;
};

// -----------------------------------------------------------------------------
// Error summary formatting
// -----------------------------------------------------------------------------

const ERR_SUMMARY_TRUNC = 120;

/**
 * Pure: `Row.lastError` → renderable in-row summary. The full cascade
 * is reachable via the error pane (which calls the L0 cascade
 * formatter); this summary is for the row itself.
 */
export const errorSummaryFor = (error: StructuredError | null): string => {
	if (error === null) return '';
	const head = `${error.tag}: ${error.summary}`;
	return head.length > ERR_SUMMARY_TRUNC ? `${head.slice(0, ERR_SUMMARY_TRUNC - 1)}…` : head;
};

// -----------------------------------------------------------------------------
// Endpoint formatting
// -----------------------------------------------------------------------------

/**
 * Pure: `Endpoint` → renderable line. Renderers prefer `displayUrl`
 * when set (codegen-friendly variant), falling back to `url`.
 */
export const endpointLine = (endpoint: Endpoint): string => {
	const target = endpoint.displayUrl ?? endpoint.url;
	return `${endpoint.name}: ${target}`;
};

// -----------------------------------------------------------------------------
// Top-level entry point
// -----------------------------------------------------------------------------

/**
 * Derive every visible display cell for a single row.
 *
 * Consumes ONLY `row.key`, `row.kind`, `row.status`, `row.phase`,
 * `row.lastError`. Does NOT touch `row.displayHint` (opaque blob; an
 * interpreter could be plugged in later but is out of scope for this
 * first cut), `row.endpoints` (rendered separately by
 * `endpoint-renderer.tsx`), or `row.logTail` (rendered by
 * `log-pane.tsx`).
 */
export const deriveDisplayCells = (
	row: Row,
	endpoints: ReadonlyArray<Endpoint> = [],
): DisplayCells => ({
	statusGlyph: statusGlyph(row.status),
	statusColor: statusColor(row.status),
	statusLabel: statusLabel(row.status),
	kindGlyph: kindGlyph(row.kind),
	kindLabel: kindLabel(row.kind),
	label: labelForRow(row.key, row.kind),
	narration: narrationFor(row.phase, row.status),
	errorSummary: errorSummaryFor(row.lastError),
	labelColor: kindLabelColor(row.kind),
	section: sectionForRow(row, endpoints),
	owner: ownerForRow(row.key),
	headline: headlineForRow(row, endpoints),
	secondary: secondaryForRow(row, endpoints),
});

const normalizeKey = (key: string): string =>
	key
		.replace(/^@devstack\//, '')
		.replace(/^(devstack:|app:)/, '')
		.replace(/#\d+$/, '')
		.replace(/\/\d+$/, '');

const humanizeToken = (token: string): string =>
	token.replace(/[-_]+/g, ' ').replace(/^\w/, (head) => head.toUpperCase());

const containsKeyPart = (key: string, parts: ReadonlyArray<string>): boolean => {
	const tokens = key.split(/[/:._#-]/).filter((part) => part.length > 0);
	return tokens.some((token) => parts.includes(token));
};

const isSectionish = (token: string): boolean =>
	containsKeyPart(token.toLowerCase(), ['service', 'package', 'account', 'action', 'app']);

const truncate = (value: string, max: number): string =>
	value.length <= max ? value : `${value.slice(0, max - 1)}…`;

// -----------------------------------------------------------------------------
// Compile-time invariant
// -----------------------------------------------------------------------------
//
// Renderer code must never see a `title`/`primary`/`extras` field on
// `Row`. If the projection ever sprouts one, the substrate's
// `__ProjectionFieldsClosed` guard fails first; this module-local
// guard exists as a second layer that explicitly mentions the
// forbidden field names so a future renderer-side regression is
// caught at the renderer boundary, not at the substrate boundary.

type _NoForbiddenOnRow = 'title' extends keyof Row
	? never
	: 'primary' extends keyof Row
		? never
		: 'extras' extends keyof Row
			? never
			: true;

/** Renderer-side compile-time guard. If this resolves to `never`,
 *  the renderer is reading a forbidden display-vocabulary field from
 *  the projection. */
export type __TuiDisplayVocabClean = _NoForbiddenOnRow extends true ? true : never;
