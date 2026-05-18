// Multi-level error renderer. Real failure modes in devstack are nested:
// a DockerError carries the stderr + exitCode from the docker CLI, then a
// SuiError wraps it with phase context, then sometimes Effect's Cause/Defect
// wraps that. The default `Error.toString()` collapses to the outermost
// class + message, hiding the actual reason ("pull access denied",
// "Cannot connect to the Docker daemon", "port already allocated") that
// the user needs to debug.
//
// `prettyError` walks the whole chain — Effect `Cause` reasons, our
// `Schema.TaggedErrorClass`-derived tagged errors, and plain `Error`s —
// and renders each layer with its structured fields plus the cause beneath.

import { Cause } from 'effect';

// Cap embedded stderr/stdout when rendering so a huge docker-pull progress
// dump doesn't drown the rest of the error tree. 8 KiB is large enough to
// capture a typical failing shell script's full output without bloating
// the TUI log row beyond what's scrollable.
const RENDER_FIELD_TRUNC = 8192;

const truncate = (s: string): string =>
	s.length > RENDER_FIELD_TRUNC ? `${s.slice(0, RENDER_FIELD_TRUNC)}…[truncated]` : s;

const indent = (s: string, prefix: string): string =>
	s
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n');

// Identifies a value as one of our `Schema.TaggedErrorClass` instances.
// We rely on `_tag` rather than `instanceof` to stay decoupled from the
// concrete classes in `primitives/errors.ts` (and the handful of tagged
// errors that live elsewhere — StateStoreLockedError, FaucetError, etc.).
interface TaggedErrorLike {
	readonly _tag: string;
	readonly message?: unknown;
	readonly cause?: unknown;
	readonly phase?: unknown;
	readonly stage?: unknown;
	readonly op?: unknown;
	readonly command?: unknown;
	readonly stderr?: unknown;
	readonly stdout?: unknown;
	readonly exitCode?: unknown;
	readonly detail?: unknown;
}

const isTaggedError = (value: unknown): value is TaggedErrorLike =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as { _tag?: unknown })._tag === 'string';

// Heuristic to detect an Effect Cause without importing the class. The
// public Cause type is an object with a `reasons: ReadonlyArray<Reason>`
// field where each reason has `_tag` of `"Fail" | "Die" | "Interrupt"`.
// We avoid `instanceof` because Effect's Cause is a structural type, not
// a named class.
interface CauseLike {
	readonly reasons: ReadonlyArray<unknown>;
}

const isCause = (value: unknown): value is CauseLike =>
	typeof value === 'object' &&
	value !== null &&
	Array.isArray((value as { reasons?: unknown }).reasons);

const renderTaggedError = (value: TaggedErrorLike): string => {
	const header = (() => {
		const qualifier =
			typeof value.phase === 'string'
				? `(${value.phase})`
				: typeof value.stage === 'string'
					? `(${value.stage})`
					: typeof value.op === 'string'
						? `(${value.op})`
						: typeof value.command === 'string'
							? `(${value.command})`
							: '';
		const message = typeof value.message === 'string' ? value.message : '';
		return qualifier ? `${value._tag} ${qualifier}: ${message}` : `${value._tag}: ${message}`;
	})();

	const lines: Array<string> = [header];
	if (typeof value.exitCode === 'number') lines.push(`  exitCode: ${value.exitCode}`);
	if (typeof value.stderr === 'string' && value.stderr.trim().length > 0) {
		lines.push(`  stderr: ${truncate(value.stderr.trim())}`);
	}
	if (typeof value.stdout === 'string' && value.stdout.trim().length > 0) {
		lines.push(`  stdout: ${truncate(value.stdout.trim())}`);
	}
	if (typeof value.detail === 'string' && value.detail.trim().length > 0) {
		lines.push(`  detail: ${truncate(value.detail.trim())}`);
	}
	if (value.cause !== undefined && value.cause !== null) {
		const rendered = prettyError(value.cause);
		// Suppress redundant `caused by:` blocks when the inner render
		// degenerates to the same one-liner as the header — happens when a
		// primitive rewraps its own DockerError without adding new context
		// downstream. We still recurse so structured fields surface.
		if (rendered.trim().length > 0 && rendered.trim() !== header.trim()) {
			lines.push('  caused by:');
			lines.push(indent(rendered, '    '));
		}
	}
	return lines.join('\n');
};

const renderError = (value: Error): string => {
	const header = `${value.name}: ${value.message}`;
	// Include the stack when present — for plain `new Error(...)` cases
	// (config import failures, raw throws from user code) the stack is the
	// only handle on where the failure originated.
	if (value.stack && value.stack !== header) {
		return value.stack;
	}
	return header;
};

/**
 * Render `value` as a multi-line human-readable error tree.
 *
 * Walks our tagged errors (DockerError, SuiError, WalrusError, SealError,
 * DeepbookError, …) — including their `phase` / `op` / `stage` / `command`
 * qualifiers and embedded `stderr` / `stdout` / `exitCode` — then recurses
 * into the `cause` field. For Effect `Cause` values, defers to
 * `Cause.pretty()` after rendering each `Fail` reason individually so our
 * tagged-error formatting still applies. Plain `Error`s render with stack;
 * everything else falls back to `String(value)`.
 */
export const prettyError = (value: unknown): string => {
	if (value === undefined || value === null) return '';
	if (isCause(value)) {
		const reasons = (value as CauseLike).reasons;
		if (reasons.length === 0) return Cause.pretty(value as Cause.Cause<unknown>);
		const rendered = reasons.map((reason) => {
			// Each reason is `{ _tag: 'Fail' | 'Die' | 'Interrupt', error?, defect? }`.
			// Recurse into whichever payload carries the inner value so a
			// tagged error inside a Fail still gets our structured render.
			const r = reason as {
				readonly _tag: string;
				readonly error?: unknown;
				readonly defect?: unknown;
			};
			if (r._tag === 'Fail' && r.error !== undefined) return prettyError(r.error);
			if (r._tag === 'Die' && r.defect !== undefined) return prettyError(r.defect);
			if (r._tag === 'Interrupt') return 'Interrupted';
			return Cause.pretty(value as Cause.Cause<unknown>);
		});
		return rendered.join('\n');
	}
	if (isTaggedError(value)) return augmentDockerDownHint(renderTaggedError(value), value);
	if (value instanceof Error) return augmentDockerDownHint(renderError(value), value);
	return String(value);
};

// Cross-cutting friendly hint when the rendered text matches one of
// the tells of a docker daemon being down. The supervisor's first
// failure in this scenario is usually a buried `connect ENOENT
// /var/run/docker.sock` or "Cannot connect to the Docker daemon" —
// the user spends minutes trying to figure out what `DockerError
// (run): pull access denied: connect ECONNREFUSED` actually means.
// Front-loading the hint keeps the diagnostic close to what the
// user has to fix.
const DOCKER_DOWN_TELLS: ReadonlyArray<string> = [
	'Cannot connect to the Docker daemon',
	'connect ENOENT /var/run/docker.sock',
	'Is the docker daemon running',
	'docker: command not found',
];

const augmentDockerDownHint = (rendered: string, source: unknown): string => {
	const text =
		rendered + ' ' + (typeof source === 'object' && source !== null ? JSON.stringify(source) : '');
	if (!DOCKER_DOWN_TELLS.some((tell) => text.includes(tell))) return rendered;
	return [
		'Docker daemon unreachable. Start Docker Desktop / colima / your daemon and re-run.',
		'  (`docker version` should print a server version when the daemon is healthy.)',
		'',
		rendered,
	].join('\n');
};

// -----------------------------------------------------------------------------
// causeToJson — structured walker for machine-readable output
// -----------------------------------------------------------------------------

/** Recursive JSON projection of a tagged error / Cause / Error chain.
 *  Mirrors what `prettyError` surfaces visually, but as structured fields
 *  so `--json` consumers can match on `_tag` / `exitCode` / `stderr` /
 *  `phase` without parsing a multi-line string. */
export interface CauseJson {
	readonly _tag?: string;
	readonly message?: string;
	readonly phase?: string;
	readonly stage?: string;
	readonly op?: string;
	readonly command?: string;
	readonly exitCode?: number;
	readonly stderr?: string;
	readonly stdout?: string;
	readonly detail?: string;
	readonly stack?: string;
	readonly cause?: CauseJson;
	readonly reasons?: ReadonlyArray<CauseJson>;
	readonly value?: unknown;
}

const truncatedString = (value: unknown): string | undefined => {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > RENDER_FIELD_TRUNC
		? `${trimmed.slice(0, RENDER_FIELD_TRUNC)}…[truncated]`
		: trimmed;
};

const taggedErrorToJson = (value: TaggedErrorLike): CauseJson => {
	const out: Record<string, unknown> = { _tag: value._tag };
	if (typeof value.message === 'string') out.message = value.message;
	if (typeof value.phase === 'string') out.phase = value.phase;
	if (typeof value.stage === 'string') out.stage = value.stage;
	if (typeof value.op === 'string') out.op = value.op;
	if (typeof value.command === 'string') out.command = value.command;
	if (typeof value.exitCode === 'number') out.exitCode = value.exitCode;
	const stderr = truncatedString(value.stderr);
	if (stderr !== undefined) out.stderr = stderr;
	const stdout = truncatedString(value.stdout);
	if (stdout !== undefined) out.stdout = stdout;
	const detail = truncatedString(value.detail);
	if (detail !== undefined) out.detail = detail;
	if (value.cause !== undefined && value.cause !== null) {
		out.cause = causeToJson(value.cause);
	}
	return out as CauseJson;
};

const errorToJson = (value: Error): CauseJson => {
	const out: Record<string, unknown> = {
		_tag: value.name,
		message: value.message,
	};
	if (value.stack !== undefined) out.stack = value.stack;
	const inner = (value as Error & { cause?: unknown }).cause;
	if (inner !== undefined && inner !== null) {
		out.cause = causeToJson(inner);
	}
	return out as CauseJson;
};

/** Project a value (tagged error, Effect `Cause`, plain `Error`,
 *  anything) into a structured JSON shape. Used by `apply --json` so
 *  the structured `_tag` / `stderr` / `exitCode` / `phase` fields ride
 *  through to consumers instead of being flattened into a single
 *  string. */
export const causeToJson = (value: unknown): CauseJson => {
	if (value === undefined || value === null) return { value: null };
	if (isCause(value)) {
		const reasons = (value as CauseLike).reasons.map((reason): CauseJson => {
			const r = reason as {
				readonly _tag: string;
				readonly error?: unknown;
				readonly defect?: unknown;
			};
			if (r._tag === 'Fail' && r.error !== undefined) {
				return { _tag: 'Fail', cause: causeToJson(r.error) };
			}
			if (r._tag === 'Die' && r.defect !== undefined) {
				return { _tag: 'Die', cause: causeToJson(r.defect) };
			}
			if (r._tag === 'Interrupt') return { _tag: 'Interrupt' };
			return { _tag: r._tag };
		});
		return { _tag: 'Cause', reasons };
	}
	if (isTaggedError(value)) return taggedErrorToJson(value);
	if (value instanceof Error) return errorToJson(value);
	return { value };
};
