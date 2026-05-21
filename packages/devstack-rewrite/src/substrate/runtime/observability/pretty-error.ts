// Pretty-error renderer.
//
// Architecture § L0 Observability: one cause walker, shared with
// renderers. The cascade-formatter is the pure walk; this module is
// the IO + convenience layer:
//   - `prettyError(unknown)`  — convenience for "I have a thrown value"
//     and don't want to thread a Cause.
//   - `prettyCause(cause)`    — the supervisor's path: the engine
//     catches via `Effect.catchCause` and renders.
//   - `prettyErrorStructured` — render to a `StructuredError` shape
//     suitable for the projection's `errors` field.
//
// This module is *thin* — all real formatting logic is in
// `cascade-formatter.ts`. Splitting them keeps the formatter pure
// + reusable while letting this module evolve IO conventions.

import type { Cause } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { StructuredError } from '../../projection.ts';

import {
	type FormatOptions,
	type FormatterRegistry,
	type TaggedErrorLike,
	formatCause,
	formatValue,
	isTaggedError,
} from './cascade-formatter.ts';

export type { FormatOptions, FormatterRegistry, TaggedErrorLike };

/** Render any value (Cause, tagged error, plain Error, anything)
 *  using the cascade rules. The pretty-error variant exists so
 *  callers don't have to know whether they have a Cause or an Error. */
export const prettyError = (value: unknown, options?: FormatOptions): string =>
	formatValue(value, options);

/** Render an Effect `Cause.Cause<E>` directly. The supervisor's preferred
 *  entry point (it has a Cause from `Effect.catchCause`). */
export const prettyCause = <E>(cause: Cause.Cause<E>, options?: FormatOptions): string =>
	formatCause(cause, options);

// -----------------------------------------------------------------------------
// Structured projection
// -----------------------------------------------------------------------------

export interface StructureOptions extends FormatOptions {
	readonly at?: number;
	readonly pluginKey?: PluginKey | null;
	readonly severity?: StructuredError['severity'];
}

/**
 * Render a Cause as a `StructuredError` suitable for the projection's
 * `errors` field. The `chain` array carries the per-layer summaries
 * (header lines only — the full multi-line render is what `prettyCause`
 * returns).
 *
 * Use the projection-shaped variant when building an `error.reported`
 * event; use `prettyCause` when rendering for human display.
 */
export const prettyErrorStructured = <E>(
	cause: Cause.Cause<E>,
	options?: StructureOptions,
): StructuredError => {
	const at = options?.at ?? Date.now();
	const pluginKey = options?.pluginKey ?? null;
	const severity = options?.severity ?? 'error';

	const { tag, summary } = extractHeadline(cause);
	const chain = extractChain(cause);

	return { at, pluginKey, tag, summary, chain, severity };
};

/** Walk the cause's first `Fail` reason and pull out the outermost
 *  tag + message for projection.summary. */
const extractHeadline = (cause: Cause.Cause<unknown>): { tag: string; summary: string } => {
	const reasons = (cause as unknown as { reasons: ReadonlyArray<{ _tag: string }> }).reasons;
	for (const reason of reasons) {
		if (reason._tag === 'Fail') {
			const error = (reason as unknown as { error: unknown }).error;
			if (isTaggedError(error)) {
				return {
					tag: error._tag,
					summary: typeof error.message === 'string' ? error.message : error._tag,
				};
			}
			if (error instanceof Error) {
				return { tag: error.name, summary: error.message };
			}
			return { tag: 'UnknownFailure', summary: String(error) };
		}
		if (reason._tag === 'Die') {
			const defect = (reason as unknown as { defect: unknown }).defect;
			if (isTaggedError(defect)) {
				return {
					tag: `Defect[${defect._tag}]`,
					summary: typeof defect.message === 'string' ? defect.message : defect._tag,
				};
			}
			if (defect instanceof Error) {
				return { tag: 'Defect', summary: defect.message };
			}
			return { tag: 'Defect', summary: String(defect) };
		}
		if (reason._tag === 'Interrupt') {
			return { tag: 'Interrupt', summary: 'fiber interrupted' };
		}
	}
	return { tag: 'EmptyCause', summary: '(empty cause)' };
};

/** Walk every layer of the cause's outermost `Fail` chain and build a
 *  list of `<tag>: <message>` strings — one per nested layer. */
const extractChain = (cause: Cause.Cause<unknown>): ReadonlyArray<string> => {
	const reasons = (cause as unknown as { reasons: ReadonlyArray<unknown> }).reasons;
	const out: Array<string> = [];
	for (const reason of reasons) {
		walkChainFromReason(reason, out, new WeakSet());
	}
	return out;
};

const walkChainFromReason = (
	reason: unknown,
	out: Array<string>,
	visited: WeakSet<object>,
): void => {
	if (typeof reason !== 'object' || reason === null) return;
	const r = reason as { _tag?: unknown; error?: unknown; defect?: unknown; fiberId?: unknown };
	if (r._tag === 'Fail') walkChainFromValue(r.error, out, visited);
	else if (r._tag === 'Die') walkChainFromValue(r.defect, out, visited);
	else if (r._tag === 'Interrupt') out.push('Interrupt');
};

const walkChainFromValue = (value: unknown, out: Array<string>, visited: WeakSet<object>): void => {
	if (value === undefined || value === null) return;
	if (typeof value === 'object') {
		if (visited.has(value as object)) return;
		visited.add(value as object);
	}
	if (isTaggedError(value)) {
		const tag = value._tag;
		const msg = typeof value.message === 'string' ? value.message : '';
		out.push(msg ? `${tag}: ${msg}` : tag);
		if (value.cause !== undefined && value.cause !== null) {
			walkChainFromValue(value.cause, out, visited);
		}
		return;
	}
	if (value instanceof Error) {
		out.push(`${value.name}: ${value.message}`);
		return;
	}
	out.push(String(value));
};
