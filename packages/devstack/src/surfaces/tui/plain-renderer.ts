// Plain (non-TTY) renderer.
//
// Architecture §11 + distilled/21-tui §Renderers: when stdout is not
// a TTY (CI, pipe, log file), the live ink dashboard is replaced by
// a structured line stream. One line per event; periodic heartbeat
// per internally-acquiring row, surfaced to operators as "starting".
//
// Discipline:
//   - One line per EngineEvent — no batching, no aggregation, no
//     diffing. Each event maps to exactly one structured line.
//   - Writes to stderr (architecture invariant: plain renderer goes
//     to stderr so stdout stays clean for whatever consumes the
//     pipe).
//   - EPIPE swallowed (pipe-safety invariant).
//   - Pure formatting helpers exposed for tests; the Effect-shaped
//     side is the `mount` function.
//   - Heartbeat formatting is pure here; scheduling belongs to the
//     renderer mount path. The architecture says it
//     "anchors on first sighting in the internal acquiring state; phase
//     changes do NOT reset the clock; a late tick emits exactly one
//     heartbeat (no backlog catch-up)". The seam is exposed via
//     `formatHeartbeat`.

import { Effect, Schema, Stream, SubscriptionRef } from 'effect';

import type { Renderer } from '../../contracts/renderer.ts';
import type { EngineEvent } from '../../substrate/events.ts';
import type { SubscribableState } from '../../substrate/projection.ts';
import {
	AccountProjectionSchema,
	PackageProjectionSchema,
} from '../../substrate/runtime/projection/persisted.ts';
import {
	accountLine,
	endpointLine,
	labelForRow,
	narrationFor,
	packageLine,
	roleLabel,
	statusLabel,
} from './display-derivation.ts';
import { mountFailed } from './errors.ts';
import { eventAt } from '../../substrate/event-time.ts';

// -----------------------------------------------------------------------------
// Line shape — pure formatters
// -----------------------------------------------------------------------------

/**
 * Plain-renderer line shape (each call returns exactly one line, no
 * trailing newline).
 *
 *   <iso-timestamp> <level> <event-tag> <key>=<value> ...
 *
 * Example:
 *   2026-05-19T20:11:32.001Z INFO lifecycle.statusChanged key=sui from=starting to=ready
 *   2026-05-19T20:11:32.500Z WARN log.appended key=walrus line="failed to bind port 9000"
 *   2026-05-19T20:11:33.000Z INFO endpoint.registered name=aggregator url=http://localhost:9000
 */
export const formatEventLine = (event: EngineEvent): string => {
	const ts = isoTimestamp(eventAt(event));
	const level = levelForEvent(event);
	const payload = payloadFor(event);
	return `${ts} ${level} ${event.tag} ${payload}`;
};

/**
 * Heartbeat line for an in-flight internal acquiring row. Emitted by the
 * scheduler at architecture-blessed intervals; this function is the
 * pure formatter only.
 */
export const formatHeartbeat = (
	now: number,
	key: string,
	phase: string | null,
	roleToken: string,
): string => {
	const ts = isoTimestamp(now);
	const narration = narrationFor(phase, 'acquiring');
	return `${ts} INFO heartbeat key=${key} role=${roleToken} narration=${quote(narration)}`;
};

// -----------------------------------------------------------------------------
// Renderer implementation
// -----------------------------------------------------------------------------

/**
 * Build a plain renderer satisfying the `Renderer` contract.
 *
 * Mount subscribes to the live event stream, writes one line per
 * event to stderr. The state-ref is sampled for the initial sweep
 * (one line per declared row) so a renderer attached after boot
 * still sees a coherent baseline.
 */
export const makePlainRenderer = (): Renderer => ({
	mount: (stateRef, events) =>
		Effect.gen(function* () {
			const initial = yield* SubscriptionRef.get(stateRef);
			yield* emitInitialSweep(initial);
			yield* events.pipe(Stream.runForEach((event) => writeStderrLine(formatEventLine(event))));
		}).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(mountFailed(cause instanceof Error ? cause.message : String(cause))),
			),
		),
	flush: Effect.void.pipe(Effect.catch(() => Effect.fail(mountFailed('flush')))),
});

// -----------------------------------------------------------------------------
// Internals — formatting
// -----------------------------------------------------------------------------

const isoTimestamp = (at: number): string => new Date(at || Date.now()).toISOString();

const levelForEvent = (event: EngineEvent): 'INFO' | 'WARN' | 'ERROR' => {
	switch (event.tag) {
		case 'log.appended':
			return event.level === 'error' ? 'ERROR' : event.level === 'warn' ? 'WARN' : 'INFO';
		case 'error.reported':
			return event.error.severity === 'fatal' || event.error.severity === 'error'
				? 'ERROR'
				: 'WARN';
		default:
			return 'INFO';
	}
};

const payloadFor = (event: EngineEvent): string => {
	switch (event.tag) {
		case 'lifecycle.statusChanged':
			return kv({
				key: event.pluginKey,
				from: statusLabel(event.from),
				to: statusLabel(event.to),
			});
		case 'lifecycle.phaseSet':
			return kv({
				key: event.pluginKey,
				phase: event.phase ?? '',
			});
		case 'log.appended':
			return kv({
				key: event.pluginKey,
				line: event.line,
			});
		case 'endpoint.registered':
			return kv({
				key: event.endpoint.endpointKey,
				name: event.endpoint.name,
				displayUrl: event.endpoint.displayUrl ?? event.endpoint.url,
				url: event.endpoint.url,
				wire: event.endpoint.wireProtocol,
			});
		case 'projection.updated':
			if (event.kind === 'account') {
				// STYLE_GUIDE §19 — substrate-side `decodeUnknownSync` so a
				// malformed payload skips the line rather than rendering
				// garbage (`Schema.decodeUnknownSync(...) as A` bare-cast
				// is banned). The reducer at
				// `substrate/runtime/projection/update.ts` performs the
				// same decode; we repeat it here because the renderer
				// reads the raw event stream, not the reduced state slice.
				const account = tryDecodeProjection(AccountProjectionSchema, event.payload);
				if (account === null) return kv({ kind: event.kind, key: event.key });
				return kv({
					key: account.key,
					row: account.rowKey ?? '',
					name: account.name,
					address: account.address ?? '',
					scheme: account.scheme ?? '',
					source: account.source ?? '',
					funding: account.funding.status,
					fundingEntries: (account.funding.entries ?? [])
						.map((entry) => `${entry.coin}:${entry.amount}:${entry.status}`)
						.join(','),
					requestedMist: account.funding.requestedMist ?? '',
					balanceMist: account.funding.balanceMist ?? '',
				});
			}
			if (event.kind === 'package') {
				const pkg = tryDecodeProjection(PackageProjectionSchema, event.payload);
				if (pkg === null) return kv({ kind: event.kind, key: event.key });
				return kv({
					key: pkg.key,
					row: pkg.rowKey ?? '',
					name: pkg.name,
					kind: pkg.kind,
					packageId: pkg.packageId,
					upgradeCapId: pkg.upgradeCapId ?? '',
					mvr: pkg.mvrPlaceholder,
				});
			}
			return kv({ kind: event.kind, key: event.key });
		case 'endpoint.released':
			return kv({ key: event.endpointKey });
		case 'strategy.registered':
			return kv({
				capability: event.capabilityKey,
				autoMounted: event.autoMounted,
			});
		case 'strategy.unregistered':
			return kv({ capability: event.capabilityKey });
		case 'manifest.flushed':
			return kv({ version: event.manifestVersion });
		case 'codegen.emitted':
			return kv({ files: event.files.length });
		case 'engine.orchestrator.dispatchFailed':
			return kv({
				key: event.pluginKey,
				kind: event.kind,
				summary: event.message,
			});
		case 'error.reported':
			return kv({
				key: event.error.pluginKey ?? '',
				tag: event.error.tag,
				summary: event.error.summary,
				cause: event.error.chain.join(' | '),
				severity: event.error.severity,
			});
		case 'build.statusChanged':
			return kv({
				key: event.entry.pluginKey ?? '',
				phase: event.entry.phase,
				progress: event.entry.progress,
			});
		case 'restart.requested':
		case 'restart.completed':
			return kv({
				target: event.target === 'stack' ? 'stack' : event.target.pluginKey,
			});
		case 'shutdown.escalated':
			return kv({
				mode: 'hard-kill',
				signal: event.signal,
				exitCode: event.exitCode,
			});
		case 'snapshot.captureStarted':
			return kv({ snapshotId: event.snapshotId, name: event.name });
		case 'snapshot.captureProgress':
			return kv({
				snapshotId: event.snapshotId,
				name: event.name,
				phase: event.phase,
				detail: event.detail,
				paused: event.pausedContainers,
				total: event.totalContainers,
			});
		case 'snapshot.captureSkipped':
			return kv({ reason: event.reason });
		case 'snapshot.captureFailed':
			return kv({ snapshotId: event.snapshotId, name: event.name, summary: event.summary });
		case 'snapshot.captured':
		case 'snapshot.restored':
			return kv({ snapshotId: event.snapshotId });
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return '';
		}
	}
};

const kv = (record: Readonly<Record<string, unknown>>): string =>
	Object.entries(record)
		.filter(([, v]) => v !== '' && v !== null && v !== undefined)
		.map(([k, v]) => `${k}=${quoteIfNeeded(String(v))}`)
		.join(' ');

// Quote anything that contains whitespace, a `"`, or an ASCII control
// byte (`\x00-\x1f`). Control bytes are the load-bearing case: a
// projection payload field that contains a stray `\x1b` (ESC) would
// otherwise inject an ANSI escape sequence into the plain-renderer's
// stdout, corrupting subsequent terminal state for callers tailing
// `--format plain` output.
const quoteIfNeeded = (s: string): string => (/[\s"\x00-\x1f]/.test(s) ? quote(s) : s);

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/**
 * Structural validate-then-narrow for `projection.updated` payloads
 * before they are formatted as text. Mirrors
 * `tryDecodeProjectionPayload` in the substrate reducer — returns
 * `null` on schema-decode failure so the renderer drops the slice
 * rather than printing fields off a malformed object. The substrate
 * reducer emits the `Effect.logWarning` for the same payload (the
 * decode is deterministic), so we stay silent here to avoid double
 * logging.
 */
const tryDecodeProjection = <S extends Schema.Decoder<unknown>>(
	schema: S,
	payload: unknown,
): S['Type'] | null => {
	try {
		return Schema.decodeUnknownSync(schema)(payload);
	} catch {
		return null;
	}
};

// -----------------------------------------------------------------------------
// Internals — initial sweep
// -----------------------------------------------------------------------------

const emitInitialSweep = (state: SubscribableState): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* writeStderrLine(
			`${isoTimestamp(state.cycle.startedAt || Date.now())} INFO stack.identity app=${state.identity.app} stack=${state.identity.stack} network=${state.identity.network} cycle=${state.cycle.id}`,
		);
		for (const row of state.rows) {
			yield* writeStderrLine(
				`${isoTimestamp(Date.now())} INFO row.declared ${kv({
					key: row.key,
					label: labelForRow(row.key),
					role: roleLabel(row.role),
					status: statusLabel(row.status),
				})}`,
			);
		}
		for (const endpoint of state.endpoints) {
			yield* writeStderrLine(
				`${isoTimestamp(endpoint.registeredAt)} INFO endpoint.registered ${endpointLine(endpoint)}`,
			);
		}
		for (const account of state.accounts) {
			yield* writeStderrLine(
				`${isoTimestamp(account.updatedAt)} INFO projection.updated[account] ${accountLine(account)}`,
			);
		}
		for (const pkg of state.packages) {
			yield* writeStderrLine(
				`${isoTimestamp(pkg.updatedAt)} INFO projection.updated[package] ${packageLine(pkg)}`,
			);
		}
	});

// -----------------------------------------------------------------------------
// Internals — IO (pipe-safe)
// -----------------------------------------------------------------------------

const writeStderrLine = (line: string): Effect.Effect<void> =>
	Effect.sync(() => {
		try {
			process.stderr.write(`${line}\n`);
		} catch (err) {
			// EPIPE swallowed (pipe-safety invariant); other errors
			// likewise swallowed because "rendering never crashes the
			// stack" (distilled/21-tui § Invariants).
			void err;
		}
	});
