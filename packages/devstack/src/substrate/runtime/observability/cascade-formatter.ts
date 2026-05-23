// L0 cascade formatter.
//
// Architecture § Substrate violations § "C2 — relocate cause walker
// from the renderer". The cascade formatter walks an Effect `Cause`
// and returns a stringified cascade of taxonomy-aware lines. Called
// from CLI, TUI, prune — anywhere a failure surfaces.
//
// Hard rules:
//   - PURE. No IO, no Effect, no clocks. Input → string.
//   - No service names: the formatter inspects `_tag` strings and
//     structured fields verbatim, never branches on a specific
//     concrete plugin error class.
//   - Pluggable per-error-class formatters via a `formatters` map
//     keyed by `_tag`. The default formatter handles tagged errors,
//     plain `Error`, defects, and Interrupts.
//
// Output shape:
//
//   <Tag> (<phase?>): <message>
//     exitCode: <n>
//     stderr: <text…[truncated]>
//     <field>: <value>
//     caused by:
//       <recursive render, indented by 2 spaces>
//
// Multi-`Fail` causes (parallel failures) render with a `--- (also)`
// separator. Defects (`Die`) render with `DEFECT (<tag>?)` prefix so
// the operator can tell programmer errors from typed failures at a
// glance. Interrupts render as `INTERRUPT[<fiberId>]`.

import type { Cause } from 'effect';

import { redactText, redactValue, type RedactionRule } from './redaction.ts';

// `Cause` is a namespace in effect v4; the actual cause type is
// `Cause.Cause<E>`. We re-alias here so call sites read naturally.
type CauseT<E> = Cause.Cause<E>;

// -----------------------------------------------------------------------------
// Plug-in formatter API
// -----------------------------------------------------------------------------

/**
 * Per-tag formatter override. Receives the tagged-error-like value
 * and the default formatter (so a plugin formatter can recurse on a
 * nested `cause` field without re-implementing the walk).
 *
 * Return `null` to fall back to the default rendering.
 *
 * Architecture: the formatter registry is keyed by `_tag` string —
 * the substrate never imports a concrete plugin error class. Plugins
 * register their custom renderer via the supervisor harvest loop over
 * `errorContributions` (see `substrate/plugin.ts:PluginErrorContribution`).
 */
export type TagFormatter = (
	value: TaggedErrorLike,
	recurse: (inner: unknown) => string,
) => string | null;

/** Per-tag formatter map. */
export type FormatterRegistry = ReadonlyMap<string, TagFormatter>;

/** Empty registry — the formatter falls back to the default
 *  rendering for every value. */
export const emptyFormatterRegistry: FormatterRegistry = new Map();

// -----------------------------------------------------------------------------
// Render budget
// -----------------------------------------------------------------------------

const DEFAULT_FIELD_TRUNCATE = 8192;
const DEFAULT_MAX_DEPTH = 12;

export interface FormatOptions {
	/** Per-tag override registry. Defaults to the empty registry. */
	readonly formatters?: FormatterRegistry;
	/** Truncate individual fields (stderr/stdout/detail) past this
	 *  length. Default 8 KiB. */
	readonly fieldTruncate?: number;
	/** Hard recursion cap. Cyclic graphs are detected separately by
	 *  visit-set; this guards against pathological cause chains.
	 *  Default 12. */
	readonly maxDepth?: number;
	/** Optional redaction rules applied before rendering string fields. */
	readonly redactions?: ReadonlyArray<RedactionRule>;
}

// -----------------------------------------------------------------------------
// Type guards (structural — no imports of concrete classes)
// -----------------------------------------------------------------------------

/** Shape of a `Schema.TaggedError` / `Data.TaggedError` instance.
 *  The cascade formatter never imports a concrete class — it dispatches
 *  on `_tag`. */
export interface TaggedErrorLike {
	readonly _tag: string;
	readonly message?: unknown;
	readonly cause?: unknown;
	readonly phase?: unknown;
	readonly stderr?: unknown;
	readonly stdout?: unknown;
	readonly exitCode?: unknown;
	readonly [key: string]: unknown;
	readonly detail?: unknown;
	readonly op?: unknown;
}

export const isTaggedError = (value: unknown): value is TaggedErrorLike =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as { _tag?: unknown })._tag === 'string';

interface CauseLike {
	readonly reasons: ReadonlyArray<ReasonLike>;
}

interface FailReasonLike {
	readonly _tag: 'Fail';
	readonly error: unknown;
}
interface DieReasonLike {
	readonly _tag: 'Die';
	readonly defect: unknown;
}
interface InterruptReasonLike {
	readonly _tag: 'Interrupt';
	readonly fiberId: number | undefined;
}
type ReasonLike = FailReasonLike | DieReasonLike | InterruptReasonLike;

const isCauseLike = (value: unknown): value is CauseLike =>
	typeof value === 'object' &&
	value !== null &&
	Array.isArray((value as { reasons?: unknown }).reasons);

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

/**
 * Format an Effect `Cause<E>` as a multi-line cascade string. Pure.
 *
 * Multiple `Fail` reasons render as separate blocks joined by
 * `--- (also)` so parallel failures are visible. Defects render with
 * a `DEFECT` prefix. Interrupts render with `INTERRUPT[<fiberId>]`.
 *
 * Cyclic `cause` chains are broken with `…[cycle]`.
 */
export const formatCause = <E>(cause: CauseT<E>, options?: FormatOptions): string => {
	const opts: Required<FormatOptions> = {
		formatters: options?.formatters ?? emptyFormatterRegistry,
		fieldTruncate: options?.fieldTruncate ?? DEFAULT_FIELD_TRUNCATE,
		maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
		redactions: options?.redactions ?? [],
	};
	const visited = new WeakSet<object>();
	const reasons = (cause as unknown as CauseLike).reasons;
	if (reasons.length === 0) return '(empty cause)';
	const rendered = reasons.map((reason) => formatReason(reason, opts, visited, 0));
	return rendered.join('\n--- (also)\n');
};

/**
 * Format an arbitrary value (a `Cause`, a tagged error, a plain
 * `Error`, or anything else) using the cascade rules. Pure.
 *
 * The pretty-error renderer (`pretty-error.ts`) is a thin wrapper
 * over this — it just sets the IO conventions (where to write,
 * what to truncate per-context). The formatting logic lives here.
 */
export const formatValue = (value: unknown, options?: FormatOptions): string => {
	const opts: Required<FormatOptions> = {
		formatters: options?.formatters ?? emptyFormatterRegistry,
		fieldTruncate: options?.fieldTruncate ?? DEFAULT_FIELD_TRUNCATE,
		maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
		redactions: options?.redactions ?? [],
	};
	return formatAny(value, opts, new WeakSet(), 0);
};

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const truncate = (s: string, limit: number, redactions: ReadonlyArray<RedactionRule>): string => {
	const redacted = redactText(s, redactions);
	return redacted.length > limit ? `${redacted.slice(0, limit)}…[truncated]` : redacted;
};

const indent = (s: string, prefix: string): string =>
	s
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n');

const formatReason = (
	reason: ReasonLike,
	opts: Required<FormatOptions>,
	visited: WeakSet<object>,
	depth: number,
): string => {
	switch (reason._tag) {
		case 'Fail':
			return formatAny(reason.error, opts, visited, depth);
		case 'Die': {
			const inner = formatAny(reason.defect, opts, visited, depth);
			return `DEFECT:\n${indent(inner, '  ')}`;
		}
		case 'Interrupt':
			return `INTERRUPT[${reason.fiberId ?? 'unknown'}]`;
	}
};

const formatAny = (
	value: unknown,
	opts: Required<FormatOptions>,
	visited: WeakSet<object>,
	depth: number,
): string => {
	if (value === undefined || value === null) return '';
	if (depth > opts.maxDepth) return '…[max depth]';
	if (typeof value === 'object') {
		if (visited.has(value as object)) return '…[cycle]';
		visited.add(value as object);
	}
	if (isCauseLike(value)) {
		const rs = value.reasons;
		if (rs.length === 0) return '(empty cause)';
		return rs.map((r) => formatReason(r, opts, visited, depth)).join('\n--- (also)\n');
	}
	if (isTaggedError(value)) {
		return formatTagged(value, opts, visited, depth);
	}
	if (value instanceof Error) {
		const header = `${value.name}: ${value.message}`;
		if (value.stack && value.stack !== header) return value.stack;
		return header;
	}
	if (typeof value === 'string') return redactText(value, opts.redactions);
	try {
		return JSON.stringify(redactValue(value, opts.redactions));
	} catch {
		return String(value);
	}
};

const formatTagged = (
	value: TaggedErrorLike,
	opts: Required<FormatOptions>,
	visited: WeakSet<object>,
	depth: number,
): string => {
	const override = opts.formatters.get(value._tag);
	if (override) {
		const result = override(value, (inner) => formatAny(inner, opts, visited, depth + 1));
		if (result !== null) return result;
	}

	const qualifier =
		typeof value.phase === 'string'
			? `(${value.phase})`
			: typeof value.op === 'string'
				? `(${value.op})`
				: '';
	const message =
		typeof value.message === 'string' ? redactText(value.message, opts.redactions) : '';
	const header = qualifier ? `${value._tag} ${qualifier}: ${message}` : `${value._tag}: ${message}`;

	const lines: Array<string> = [header];
	if (typeof value.exitCode === 'number') lines.push(`  exitCode: ${value.exitCode}`);
	if (typeof value.stderr === 'string' && value.stderr.trim().length > 0) {
		lines.push(`  stderr: ${truncate(value.stderr.trim(), opts.fieldTruncate, opts.redactions)}`);
	}
	if (typeof value.stdout === 'string' && value.stdout.trim().length > 0) {
		lines.push(`  stdout: ${truncate(value.stdout.trim(), opts.fieldTruncate, opts.redactions)}`);
	}
	if (typeof value.detail === 'string' && value.detail.trim().length > 0) {
		lines.push(`  detail: ${truncate(value.detail.trim(), opts.fieldTruncate, opts.redactions)}`);
	}

	// Surface any extra plain-data fields the tagged error carries.
	// We skip the conventional ones already rendered above plus `_tag`,
	// `cause`. This makes the formatter discover-by-shape: a plugin
	// adding `path` or `kind` to its error gets it rendered for free.
	const conventional = new Set([
		'_tag',
		'message',
		'cause',
		'phase',
		'stderr',
		'stdout',
		'exitCode',
		'detail',
		'op',
	]);
	for (const key of Object.keys(value)) {
		if (conventional.has(key)) continue;
		const v = (value as unknown as Record<string, unknown>)[key];
		if (v === undefined || v === null) continue;
		const rendered =
			typeof v === 'string'
				? truncate(v, opts.fieldTruncate, opts.redactions)
				: typeof v === 'number' || typeof v === 'boolean'
					? String(v)
					: safeJson(v, opts.fieldTruncate, opts.redactions);
		lines.push(`  ${key}: ${rendered}`);
	}

	if (value.cause !== undefined && value.cause !== null) {
		const rendered = formatAny(value.cause, opts, visited, depth + 1);
		if (rendered.trim().length > 0 && rendered.trim() !== header.trim()) {
			lines.push('  caused by:');
			lines.push(indent(rendered, '    '));
		}
	}
	return lines.join('\n');
};

const safeJson = (
	value: unknown,
	limit: number,
	redactions: ReadonlyArray<RedactionRule>,
): string => {
	try {
		return truncate(JSON.stringify(redactValue(value, redactions)), limit, redactions);
	} catch {
		return '[unserializable]';
	}
};
