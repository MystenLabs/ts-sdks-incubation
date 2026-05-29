// Presentation derivation — the single seam translating raw projection values
// into the dashboard's display vocabulary (semantic color token + glyph +
// label). Mirrors the TUI's display-derivation. Pure functions only: no React,
// no DOM, no I/O. The `ui/` layer maps a `StatusToken` onto concrete styling
// (the `.dot-<token>` classes + `var(--c-<token>)` colors); panels consume
// these helpers.

import {
	type Endpoint,
	type FundingStatus,
	type LifecycleStatus,
	type PluginRole,
	type Row,
	type RowSection,
	SECTION_ORDER,
	type StructuredError,
} from './types.ts';
import { humanize } from './format.ts';

/** Semantic ColorTokens, matching the design tokens (`--st-*`) one-to-one. */
export type StatusToken =
	| 'green'
	| 'yellow'
	| 'red'
	| 'cyan'
	| 'magenta'
	| 'blue'
	| 'white'
	| 'dim';

export interface StatusDisplay {
	readonly token: StatusToken;
	readonly glyph: string;
	readonly label: string;
	/** Whether the status dot should pulse (in-flight states). */
	readonly pulse: boolean;
}

const STATUS: Record<LifecycleStatus, StatusDisplay> = {
	pending: { token: 'white', glyph: '○', label: 'Pending', pulse: false },
	acquiring: { token: 'cyan', glyph: '◌', label: 'Acquiring', pulse: true },
	ready: { token: 'green', glyph: '●', label: 'Ready', pulse: false },
	failed: { token: 'red', glyph: '✕', label: 'Failed', pulse: false },
	stopping: { token: 'yellow', glyph: '◐', label: 'Stopping', pulse: true },
	stopped: { token: 'dim', glyph: '◌', label: 'Stopped', pulse: false },
	done: { token: 'green', glyph: '✓', label: 'Done', pulse: false },
};

export const statusDisplay = (status: LifecycleStatus): StatusDisplay => STATUS[status];

export interface RoleDisplay {
	readonly label: string;
	readonly token: StatusToken;
}

export const roleDisplay = (role: PluginRole): RoleDisplay =>
	role === 'task' ? { label: 'task', token: 'magenta' } : { label: 'service', token: 'cyan' };

const SECTION_LABEL: Record<RowSection, string> = {
	service: 'Services',
	package: 'Packages',
	account: 'Accounts',
	action: 'Actions',
	app: 'App',
	other: 'Other',
};

const SECTION_TOKEN: Record<RowSection, StatusToken> = {
	service: 'cyan',
	package: 'blue',
	account: 'magenta',
	action: 'yellow',
	app: 'green',
	other: 'white',
};

export const sectionLabel = (section: RowSection): string => SECTION_LABEL[section];

export const sectionToken = (section: RowSection): StatusToken => SECTION_TOKEN[section];

export type Health = 'ready' | 'active' | 'blocked' | 'empty';

export interface HealthSummary {
	readonly total: number;
	readonly ready: number;
	readonly active: number;
	readonly failed: number;
	readonly waiting: number;
	readonly health: Health;
}

export const summarize = (rows: ReadonlyArray<Pick<Row, 'status'>>): HealthSummary => {
	let ready = 0;
	let active = 0;
	let failed = 0;
	let waiting = 0;
	for (const row of rows) {
		if (row.status === 'ready' || row.status === 'done') ready += 1;
		else if (row.status === 'failed') failed += 1;
		else if (row.status === 'acquiring' || row.status === 'stopping') active += 1;
		else if (row.status === 'pending') waiting += 1;
	}
	const health: Health =
		rows.length === 0
			? 'empty'
			: failed > 0
				? 'blocked'
				: active > 0 || waiting > 0
					? 'active'
					: 'ready';
	return { total: rows.length, ready, active, failed, waiting, health };
};

export const healthToken = (health: Health): StatusToken => {
	switch (health) {
		case 'ready':
			return 'green';
		case 'active':
			return 'yellow';
		case 'blocked':
			return 'red';
		case 'empty':
			return 'dim';
	}
};

export interface FundingDisplay {
	readonly label: string;
	readonly token: StatusToken;
}

export const fundingDisplay = (status: FundingStatus): FundingDisplay => {
	switch (status) {
		case 'funded':
			return { label: 'funded', token: 'green' };
		case 'pending':
			return { label: 'pending', token: 'cyan' };
		case 'skipped':
			return { label: 'skipped', token: 'dim' };
		case 'failed':
			return { label: 'failed', token: 'red' };
		case 'unknown':
			return { label: 'unknown', token: 'dim' };
	}
};

/**
 * Derive a friendly label from an opaque plugin key. Keys look like
 * `account/alice#1`, `package:managed_coin#2`, `sui#0`, `dashboard#3`.
 */
export const labelForRow = (key: string): string => {
	const withoutInstance = key.replace(/#\d+$/, '');
	const lastToken = withoutInstance.split(/[:/]/).pop() ?? withoutInstance;
	return humanize(lastToken);
};

/** Owner/namespace prefix of a key (the part before `:` or `/`), if any. */
export const ownerForRow = (key: string): string | null => {
	const withoutInstance = key.replace(/#\d+$/, '');
	const match = withoutInstance.match(/^([^:/]+)[:/]/);
	return match ? match[1] : null;
};

const OPERATIONAL_ENDPOINT = /^(rpc|faucet|graphql)$/i;

/** Endpoints owned by a row, resolved against the endpoint registry. */
export const endpointsForRow = (
	row: Pick<Row, 'key' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint>,
): ReadonlyArray<Endpoint> => {
	const owned = new Set(row.endpoints);
	return endpoints.filter((e) => owned.has(e.endpointKey) || e.pluginKey === row.key);
};

/** Row endpoints minus the operational rpc/faucet/graphql trio. */
export const visibleEndpointsForRow = (
	row: Pick<Row, 'key' | 'endpoints'>,
	endpoints: ReadonlyArray<Endpoint>,
): ReadonlyArray<Endpoint> =>
	endpointsForRow(row, endpoints).filter((e) => !OPERATIONAL_ENDPOINT.test(e.name));

/** Compact one-line summary of a structured error. */
export const errorSummary = (error: StructuredError | null): string => {
	if (!error) return '';
	const detail = error.chain[0];
	const base = error.tag ? `${error.tag}: ${error.summary}` : error.summary;
	const full = detail && detail !== error.summary ? `${base} — ${detail}` : base;
	return full.length > 160 ? `${full.slice(0, 159)}…` : full;
};

/** A row's one-line narration: its error summary when failed, else its phase. */
export const rowNarration = (row: Pick<Row, 'status' | 'phase' | 'lastError'>): string =>
	row.status === 'failed' ? errorSummary(row.lastError) || 'Failed' : (row.phase ?? '');

export interface RowGroup {
	readonly section: RowSection;
	readonly label: string;
	readonly rows: ReadonlyArray<Row>;
}

/** Group rows by section, ordered by the canonical section order. */
export const groupRows = (rows: ReadonlyArray<Row>): ReadonlyArray<RowGroup> => {
	const groups = new Map<RowSection, Row[]>();
	for (const row of rows) {
		const list = groups.get(row.section) ?? [];
		list.push(row);
		groups.set(row.section, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (SECTION_ORDER.indexOf(a) + 1 || 99) - (SECTION_ORDER.indexOf(b) + 1 || 99))
		.map(([section, sectionRows]) => ({
			section,
			label: sectionLabel(section),
			rows: sectionRows,
		}));
};
