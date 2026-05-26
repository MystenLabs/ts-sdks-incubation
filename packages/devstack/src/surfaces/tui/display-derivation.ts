// Display derivation — the load-bearing transducer that makes the
// "no display vocab in projection" invariant testable.
//
// The renderer consumes ONLY the typed projection (`Row`, `Endpoint`,
// `StructuredError`, `LifecycleStatus`, `PluginRole`, ...) from
// `substrate/projection.ts`. Every visible glyph, color, label, and
// narration string is computed HERE from `row.role`, `row.status`,
// `row.phase`, `row.lastError`, etc.
//
// HARD INVARIANT: this module never reads a field named `title`,
// `primary`, or `extras` — those fields don't exist on the projection
// (the substrate's `__ProjectionFieldsClosed` guard fails to compile
// if they did). The TUI's test of that invariant is: every visible
// cell rendered by `resource-table.tsx` flows through one of these pure
// functions.
//
// Pure. No Effect, no IO, no clocks. Input typed projection → output
// strings + enum-y "color tokens" (resolved to terminal colors by the
// Ink layer via `Text color={…}`).

import type { LifecycleStatus, PhaseNarration, PluginRole } from '../../substrate/lifecycle.ts';
import type {
	AccountProjection,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
} from '../../substrate/projection.ts';

// -----------------------------------------------------------------------------
// Color tokens
// -----------------------------------------------------------------------------

/**
 * Closed set of color tokens the TUI uses. Ink resolves these to ANSI
 * sequences. NO_COLOR / FORCE_COLOR / TERM=dumb are honored by Ink's
 * defaults (Tension: TUI must not override user color preferences).
 */
export type ColorToken = 'yellow' | 'green' | 'red' | 'magenta' | 'cyan' | 'blueBright' | 'white';

// -----------------------------------------------------------------------------
// Display cells — the public output shape of this module
// -----------------------------------------------------------------------------

/**
 * Per-row display cells the row renderer consumes. None of these
 * fields are read from the projection — they are computed from
 * `Row.role` + `Row.status` + `Row.phase` + `Row.lastError`.
 *
 * Naming note: we DELIBERATELY avoid the words `title`, `primary`,
 * `extras` in this type's field names to make the invariant grep-able.
 * `label` is computed from `key`; `narration` from `phase`;
 * `summary` from `lastError`.
 */
export interface DisplayCells {
	/** Status glyph (single char). */
	readonly statusGlyph: string;
	/** Status color token. */
	readonly statusColor: ColorToken;
	/** Status label (short verbal, e.g. "ready"). */
	readonly statusLabel: string;
	/** Role glyph (single char). */
	readonly roleGlyph: string;
	/** Role label (e.g. "service"). */
	readonly roleLabel: string;
	/** Computed row label — derived from `row.key`, not from any
	 *  projection-side `title`. */
	readonly label: string;
	/** Narration line — formatted from `row.phase`. */
	readonly narration: string;
	/** Error summary — formatted from `row.lastError`. */
	readonly errorSummary: string;
	/** Color the row's label should render in (role-derived,
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

interface RowSectionClassifier {
	readonly prefixes: ReadonlyArray<string>;
	readonly section: RowSection;
	readonly endpointSection?: RowSection;
}

const ROW_SECTION_CLASSIFIERS = [
	{ prefixes: ['package:', 'package/'], section: 'package' },
	{ prefixes: ['account/'], section: 'account' },
	{ prefixes: ['action:', 'action/'], section: 'action' },
	{ prefixes: ['coin:'], section: 'action' },
	{ prefixes: ['app:', 'app/'], section: 'app', endpointSection: 'service' },
	{ prefixes: ['host-service/'], section: 'service' },
	{ prefixes: ['sui'], section: 'service' },
	{ prefixes: ['wallet'], section: 'service' },
	{ prefixes: ['walrus:', 'walrus/'], section: 'service' },
	{ prefixes: ['seal:', 'seal/'], section: 'service' },
	{ prefixes: ['deepbook:', 'deepbook/'], section: 'service' },
	{ prefixes: ['postgres'], section: 'service' },
	{ prefixes: ['faucet'], section: 'service' },
] as const satisfies ReadonlyArray<RowSectionClassifier>;

export interface DisplayRow {
	readonly row: Row;
	readonly cells: DisplayCells;
}

export interface DisplaySection {
	readonly key: RowSection;
	readonly label: string;
	readonly rows: ReadonlyArray<DisplayRow>;
}

export interface DashboardSummary {
	readonly totalRows: number;
	readonly readyRows: number;
	readonly activeRows: number;
	readonly failedRows: number;
	readonly waitingRows: number;
	readonly endpointCount: number;
	readonly accountCount: number;
	readonly packageCount: number;
	readonly errorCount: number;
	readonly health: 'ready' | 'active' | 'blocked' | 'empty';
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
			return 'white';
		case 'acquiring':
			return 'yellow';
		case 'ready':
			return 'green';
		case 'failed':
			return 'red';
		case 'stopping':
			return 'yellow';
		case 'stopped':
			return 'white';
		case 'done':
			return 'green';
		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return 'white';
		}
	}
};

/** Pure: status → short operator-facing label. */
export const statusLabel = (status: LifecycleStatus): string => {
	switch (status) {
		case 'pending':
			return 'pending';
		case 'acquiring':
			return 'starting';
		case 'ready':
			return 'ready';
		case 'failed':
			return 'failed';
		case 'stopping':
			return 'stopping';
		case 'stopped':
			return 'stopped';
		case 'done':
			return 'done';
		default: {
			const _exhaustive: never = status;
			void _exhaustive;
			return 'unknown';
		}
	}
};

// -----------------------------------------------------------------------------
// Role -> glyph / label / color
// -----------------------------------------------------------------------------

/** Pure: role -> ANSI glyph. */
export const roleGlyph = (role: PluginRole): string => {
	switch (role) {
		case 'service':
			return '⚙';
		case 'task':
			return '⚡';
		default: {
			const _exhaustive: never = role;
			void _exhaustive;
			return '?';
		}
	}
};

/** Pure: role -> short label. */
export const roleLabel = (role: PluginRole): string => {
	switch (role) {
		case 'service':
			return 'service';
		case 'task':
			return 'task';
		default: {
			const _exhaustive: never = role;
			void _exhaustive;
			return 'unknown';
		}
	}
};

/** Pure: role -> label color token. */
export const roleLabelColor = (role: PluginRole): ColorToken => {
	switch (role) {
		case 'service':
			return 'cyan';
		case 'task':
			return 'magenta';
		default: {
			const _exhaustive: never = role;
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
 * The function consumes `key` only — never `row.title`, which doesn't
 * exist in the projection.
 */
export const labelForRow = (key: string): string => {
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
	row: Pick<Row, 'key' | 'role' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint> = [],
): RowSection => {
	const normalized = normalizeClassificationKey(row.key).toLowerCase();
	const ownsEndpoint = endpointsForRow(row, endpoints).length > 0 || row.endpoints.length > 0;
	const classifier = rowSectionClassifierFor(normalized);
	if (classifier !== undefined) {
		if (ownsEndpoint && classifier.endpointSection !== undefined) return classifier.endpointSection;
		return classifier.section;
	}
	if (row.role === 'service' || ownsEndpoint) return 'service';
	if (row.role === 'task') return 'action';
	return 'other';
};

/** Pure: key-only section classifier. Used by event-log scope coloring
 *  where only the `pluginKey` is in hand (no `Row`/`Endpoint` context).
 *  Falls back to `'other'` when no classifier prefix matches. */
export const sectionForKey = (key: string): RowSection => {
	const normalized = normalizeClassificationKey(key).toLowerCase();
	const classifier = rowSectionClassifierFor(normalized);
	return classifier === undefined ? 'other' : classifier.section;
};

/** Pure: section -> scope-chip color token used by the event log /
 *  activity stream. Coloring is driven by `RowSection` so the renderer
 *  doesn't pattern-match on plugin names. */
export const sectionColor = (section: RowSection): ColorToken => {
	switch (section) {
		case 'service':
			return 'cyan';
		case 'package':
			return 'blueBright';
		case 'account':
			return 'magenta';
		case 'action':
			return 'magenta';
		case 'app':
			return 'white';
		case 'other':
			return 'cyan';
		default: {
			const _exhaustive: never = section;
			void _exhaustive;
			return 'cyan';
		}
	}
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

const OPERATIONAL_ENDPOINT_FIELDS = new Set(['url', 'rpcUrl', 'faucetUrl', 'graphqlUrl']);

export const visibleEndpointsForRow = (
	row: Pick<Row, 'key' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint>,
): ReadonlyArray<Endpoint> => {
	const rowEndpoints = endpointsForRow(row, endpoints);
	const routed = rowEndpoints.filter((endpoint) => !isOperationalEndpoint(row.key, endpoint));
	return routed.length > 0 ? routed : rowEndpoints;
};

export const headlineForRow = (row: Row, endpoints: ReadonlyArray<Endpoint> = []): string => {
	const rowEndpoints = visibleEndpointsForRow(row, endpoints);
	if (rowEndpoints.length > 0) return endpointLine(rowEndpoints[0]!);
	if (row.lastError !== null && row.status === 'failed') return errorSummaryFor(row.lastError);
	return narrationFor(row.phase, row.status);
};

export const secondaryForRow = (
	row: Row,
	endpoints: ReadonlyArray<Endpoint> = [],
): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const rowEndpoints = endpointsForRow(row, endpoints);
	for (const endpoint of rowEndpoints.slice(1)) out.push(endpointLine(endpoint));
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

export const deriveDashboardSummary = (
	state: Pick<SubscribableState, 'rows' | 'endpoints' | 'accounts' | 'packages' | 'errors'>,
): DashboardSummary => {
	const readyRows = state.rows.filter(
		(row) => row.status === 'ready' || row.status === 'done',
	).length;
	const activeRows = state.rows.filter(
		(row) => row.status === 'acquiring' || row.status === 'stopping',
	).length;
	const failedRows = state.rows.filter((row) => row.status === 'failed').length;
	const waitingRows = state.rows.filter(
		(row) => row.status === 'pending' || row.status === 'stopped',
	).length;
	const health =
		state.rows.length === 0
			? 'empty'
			: failedRows > 0
				? 'blocked'
				: activeRows > 0 || waitingRows > 0
					? 'active'
					: 'ready';
	return {
		totalRows: state.rows.length,
		readyRows,
		activeRows,
		failedRows,
		waitingRows,
		endpointCount: visibleEndpointCount(state.rows, state.endpoints),
		accountCount: state.accounts.length,
		packageCount: state.packages.length,
		errorCount: state.errors.length,
		health,
	};
};

const visibleEndpointCount = (
	rows: ReadonlyArray<Row>,
	endpoints: ReadonlyArray<Endpoint>,
): number => {
	const rowOwned = new Set<Endpoint['endpointKey']>();
	const visible = new Set<Endpoint['endpointKey']>();
	for (const row of rows) {
		for (const endpoint of endpointsForRow(row, endpoints)) {
			rowOwned.add(endpoint.endpointKey);
		}
		for (const endpoint of visibleEndpointsForRow(row, endpoints)) {
			visible.add(endpoint.endpointKey);
		}
	}
	for (const endpoint of endpoints) {
		if (!rowOwned.has(endpoint.endpointKey)) visible.add(endpoint.endpointKey);
	}
	return visible.size;
};

export const dashboardSummaryLine = (summary: DashboardSummary): string =>
	[
		`${summary.readyRows}/${summary.totalRows} ready`,
		summary.activeRows > 0 ? `${summary.activeRows} active` : null,
		summary.waitingRows > 0 ? `${summary.waitingRows} waiting` : null,
		summary.failedRows > 0 ? `${summary.failedRows} failed` : null,
		`${summary.endpointCount} urls`,
		`${summary.accountCount} accounts`,
		summary.packageCount > 0 ? `${summary.packageCount} packages` : null,
		summary.errorCount === 0 ? 'no errors' : `${summary.errorCount} errors`,
	]
		.filter((part): part is string => part !== null)
		.join('  ');

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
 * Pure: `Row.lastError` → renderable in-row summary. Keep it short;
 * detailed error context belongs in the activity/log stream.
 */
export const errorSummaryFor = (error: StructuredError | null): string => {
	if (error === null) return '';
	const head = `${error.tag}: ${error.summary}`;
	const detail = error.chain.find((line) => line !== head && line !== error.tag);
	const compactDetail =
		detail === undefined ? undefined : detail.replace(/^[A-Za-z0-9_[\]-]+:\s*/, '');
	const summary = compactDetail === undefined ? head : `${head}: ${compactDetail}`;
	return summary.length > ERR_SUMMARY_TRUNC
		? `${summary.slice(0, ERR_SUMMARY_TRUNC - 1)}…`
		: summary;
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
	const backing =
		endpoint.displayUrl !== null && endpoint.displayUrl !== endpoint.url
			? ` -> ${endpoint.url}`
			: '';
	const protocol = endpoint.wireProtocol === 'http' ? '' : ` [${endpoint.wireProtocol}]`;
	return `${endpoint.name}: ${target}${backing}${protocol}`;
};

export const endpointsSummaryForRow = (
	row: Pick<Row, 'key' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint>,
): string => {
	const rowEndpoints = visibleEndpointsForRow(row, endpoints);
	if (rowEndpoints.length === 0) return '';
	return rowEndpoints.map(endpointLine).join(' | ');
};

export const accountLine = (account: AccountProjection): string => {
	const address = account.address ?? '<pending>';
	const scheme = account.scheme ?? 'scheme pending';
	const source = account.source ?? 'source pending';
	const funding = accountFundingLine(account.funding);
	const wallet = account.walletVisible ? 'wallet' : null;
	return [humanizeToken(account.name), address, scheme, source, funding, wallet]
		.filter((part): part is string => part !== null && part.length > 0)
		.join('  ');
};

export const packageLine = (pkg: PackageProjection): string => {
	return [humanizeToken(pkg.name), pkg.packageId, pkg.mvrPlaceholder, pkg.kind]
		.filter((part): part is string => part !== null && part.length > 0)
		.join('  ');
};

export interface AccountCells {
	readonly name: string;
	readonly address: string;
	readonly scheme: string;
	readonly source: string;
	readonly funding: string;
}

export interface PackageCells {
	readonly name: string;
	readonly packageId: string;
	readonly mvr: string;
	readonly kind: string;
	readonly detail: string;
}

export const accountCells = (account: AccountProjection): AccountCells => ({
	name: humanizeToken(account.name),
	address: account.address ?? '<pending>',
	scheme: account.scheme ?? 'pending',
	source: account.source ?? 'pending',
	funding: accountFundingLine(account.funding),
});

const accountFundingLine = (funding: AccountProjection['funding']): string => {
	const entries = funding.entries ?? [];
	if (entries.length > 0) {
		const rendered = entries
			.map(
				(entry) => `${entry.coin}:${entry.amount}${entry.status === 'skipped' ? ' skipped' : ''}`,
			)
			.join(', ');
		return funding.status === 'funded' ? `funded ${rendered}` : `funding ${rendered}`;
	}
	switch (funding.status) {
		case 'pending':
			return funding.requestedMist === null
				? 'funding pending'
				: `funding ${funding.requestedMist}`;
		case 'funded':
			return funding.balanceMist !== null
				? `funded ${funding.balanceMist}`
				: funding.requestedMist !== null
					? `funded ${funding.requestedMist}`
					: 'funded';
		case 'skipped':
			return 'funding skipped';
		case 'failed':
			return 'funding failed';
		case 'unknown':
			return 'funding unknown';
		default: {
			const _exhaustive: never = funding.status;
			void _exhaustive;
			return '';
		}
	}
};

export const packageCells = (pkg: PackageProjection): PackageCells => ({
	name: humanizeToken(pkg.name),
	packageId: pkg.packageId,
	mvr: pkg.mvrPlaceholder,
	kind: pkg.kind,
	detail: pkg.kind,
});

// -----------------------------------------------------------------------------
// Top-level entry point
// -----------------------------------------------------------------------------

/**
 * Derive every visible display cell for a single row.
 *
 * Consumes ONLY `row.key`, `row.role`, `row.status`, `row.phase`,
 * `row.lastError`, `row.endpoints` (rendered separately by
 * `resource-table.tsx`), or `row.logTail` (kept in the projection
 * for renderer variants that need tails, but not used as primary
 * dashboard state because generic lifecycle log lines duplicate the
 * table).
 */
export const deriveDisplayCells = (
	row: Row,
	endpoints: ReadonlyArray<Endpoint> = [],
): DisplayCells => ({
	statusGlyph: statusGlyph(row.status),
	statusColor: statusColor(row.status),
	statusLabel: statusLabel(row.status),
	roleGlyph: roleGlyph(row.role),
	roleLabel: roleLabel(row.role),
	label: labelForRow(row.key),
	narration: narrationFor(row.phase, row.status),
	errorSummary: errorSummaryFor(row.lastError),
	labelColor: roleLabelColor(row.role),
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

const normalizeClassificationKey = (key: string): string =>
	key
		.replace(/^@devstack\//, '')
		.replace(/^devstack:/, '')
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

const rowSectionClassifierFor = (key: string): RowSectionClassifier | undefined =>
	ROW_SECTION_CLASSIFIERS.find((classifier) =>
		classifier.prefixes.some((prefix) => keyMatchesClassifierPrefix(key, prefix)),
	);

const keyMatchesClassifierPrefix = (key: string, prefix: string): boolean => {
	if (prefix.endsWith(':') || prefix.endsWith('/')) return key.startsWith(prefix);
	if (key === prefix) return true;
	const next = key[prefix.length];
	return key.startsWith(prefix) && next !== undefined && '/:._-'.includes(next);
};

const isOperationalEndpoint = (rowKey: Pick<Row, 'key'>['key'], endpoint: Endpoint): boolean => {
	const prefix = `${rowKey}:`;
	if (!endpoint.endpointKey.startsWith(prefix)) return false;
	const field = endpoint.endpointKey.slice(prefix.length);
	return OPERATIONAL_ENDPOINT_FIELDS.has(field);
};

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
