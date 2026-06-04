// Port broker — substrate-level service.
//
// Architecture (`notes/redesign/architecture.md` § "What's collapsed"):
// resource broker for host ports. Plugins that need to bind a host
// HTTP server or publish a container port on the host yield this
// service and call `allocate({...})`. The broker:
//
//   1. Tracks in-process allocations in a `Ref<Map<port, Holder>>` so
//      two sibling plugins in the same stack don't both pick the same
//      port between bind-probe and `server.listen`.
//   2. Claims a runtime-root scoped port reservation file before the
//      bind probe. This closes the cross-process probe→listen race:
//      two independent `devstack apply` processes sharing a state dir
//      cannot both choose the same candidate while neither real server
//      is listening yet.
//   3. Verifies kernel-level availability by binding a transient
//      `net.Server` on the candidate port and closing it.
//      The OS's `EADDRINUSE` remains the final collision check for
//      non-devstack processes and stale reservation gaps.
//   4. Releases on scope close. The broker hands back a `release`
//      Effect AND installs a scope finalizer; the architecture's
//      "scope-local, never module-level" invariant is honoured by
//      construction (the Layer is scope-local, the entries die with
//      the scope).
//
// Sequential search: callers may pass `preferredPort` (tried first) and
// an optional `windowHint: { start, size }` (the scan window if
// preferred is busy or absent). The default window —
// `DEFAULT_PORT_WINDOW` below — is intentionally wide enough for any
// realistic in-process devstack; plugins do NOT freelance per-kind
// window starts. The substrate stays name-blind: there is no `PortKind`
// literal; plugins are opaque port-holders from the broker's view.
//
// Cross-process safety: the reservation file is scoped to the runtime
// root, not the stack root, because host ports are machine-global. The
// stack-scoped supervisor lock serializes acquires of the SAME stack;
// these reservation files serialize host-port choices across DIFFERENT
// stacks and apps that share a state dir.

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import {
	createServer as createNetServer,
	type AddressInfo,
	type Server as NetServer,
} from 'node:net';
import { join } from 'node:path';

import { Context, Effect, Layer, Ref, Schema, Scope } from 'effect';

import { RosterHolderSchema, type RosterHolder } from '../../cross-process.ts';
import { atomicWriteFileExclusiveSync } from '../atomic-write.ts';
import { checkHolderLiveness, ownHolder } from '../cross-process/liveness.ts';
import { selfPid } from '../cross-process/self-pid.ts';
import { PortBrokerError } from '../errors.ts';
import { RuntimeRoot } from '../paths.ts';
import { decodeJsonTextSync } from '../runtime-decode.ts';
import { versionedDocSchema } from '../../versioned-doc-schema.ts';

// ----------------------------------------------------------------------
// Public shape
// ----------------------------------------------------------------------

/** Host interface used by the transient bind probe. Callers binding a
 *  real server on loopback should use the default. Callers that hand
 *  the port to Docker's all-interface publish path should pass
 *  `'0.0.0.0'` so the probe asks the same kernel question. */
export type PortProbeHost = '127.0.0.1' | '0.0.0.0';

/** Optional per-call window override. The broker scans
 *  `[start, start + size)` in order when `preferredPort` is busy or
 *  absent. Plugins with UX-pinned ports (e.g. a dev wallet whose
 *  legacy adapters auto-connect to a specific range) pass this so the
 *  fall-back range stays predictable; everyone else gets the default. */
export interface PortAllocationWindow {
	readonly start: number;
	readonly size?: number;
}

/** Default scan window. Sized for "tens of plugins per stack" with
 *  parallel-stack overhead headroom. 1000 ports is more than enough for
 *  any realistic in-process devstack; the forward-scan only ever
 *  reaches the end if EVERY port in the window is taken (effectively
 *  never on dev machines). Start chosen to land between common dev
 *  defaults (3000-5173, 8000-8080) and the ephemeral range so a
 *  sibling Vite/Next process doesn't accidentally collide on the
 *  first probe. */
export const DEFAULT_PORT_WINDOW: Required<PortAllocationWindow> = {
	start: 39200,
	size: 1000,
};

/** Input to `allocate`. */
export interface AllocateOptions {
	/** Optional caller hint. The broker tries this FIRST; if the port is
	 *  already held in-process the call FAILS with
	 *  `reason: 'preferred-busy'` (the caller asked specifically for
	 *  this port and got an obvious collision). If the bind-probe fails
	 *  with EADDRINUSE the broker falls through to the window scan —
	 *  preferred is a HINT for the kernel-collision case, but a HARD
	 *  CHOICE against in-process collision. */
	readonly preferredPort?: number;
	/** Interface to bind during the kernel probe. Defaults to
	 *  `127.0.0.1`, matching host-loopback servers. Docker
	 *  `-p host:container` publishes on all interfaces, so Docker-backed
	 *  callers pass `0.0.0.0`. */
	readonly probeHost?: PortProbeHost;
	/** Optional per-call window override; defaults to
	 *  `DEFAULT_PORT_WINDOW`. */
	readonly windowHint?: PortAllocationWindow;
	/** Optional free-form owner label for diagnostics (`no-free-port`
	 *  error detail). The broker treats this as opaque; pass something
	 *  short and human-readable like `'wallet'` or `'sui:rpc'`. */
	readonly owner?: string;
}

/** Successful allocation. `release` is provided in addition to the
 *  scope finalizer so tests / orchestrators can drive release
 *  explicitly without unwinding the whole scope. Calling `release`
 *  twice is a no-op. */
export interface AllocatedPort {
	readonly port: number;
	readonly release: Effect.Effect<void>;
}

/** Service shape — what plugins yield from Context. */
export interface PortBroker {
	/**
	 * Allocate a port. The returned port is exclusive within THIS
	 * process (the broker's `Ref` map) and best-effort-exclusive across
	 * devstack processes that share a runtime root (port reservation
	 * file), then verified against the kernel bind table on `probeHost`.
	 *
	 * Scope-bound release: the broker installs a finalizer on the
	 * surrounding scope; callers can additionally invoke
	 * `result.release` explicitly.
	 *
	 * Failures (`PortBrokerError`):
	 *   - `preferred-busy` — caller's `preferredPort` is held by another
	 *     in-process allocation on the same stack.
	 *   - `no-free-port` — the scan window was exhausted without a
	 *     probe-pass candidate.
	 *   - `bind-probe-failed` — non-EADDRINUSE error from the OS bind
	 *     probe (EACCES on a privileged port etc.).
	 *   - `reservation-failed` — port reservation file IO failed.
	 */
	readonly allocate: (
		opts?: AllocateOptions,
	) => Effect.Effect<AllocatedPort, PortBrokerError, Scope.Scope>;
}

// ----------------------------------------------------------------------
// Internal state
// ----------------------------------------------------------------------

const DEFAULT_OWNER = 'unknown';

/** In-process holder for a port. Carries the owner string for
 *  diagnostics (e.g. surfaced in `no-free-port` errors). */
interface Holder {
	readonly owner: string;
}

type State = ReadonlyMap<number, Holder>;

// Reservation-doc shape. NOTE: this changed incompatibly from an
// earlier `{ version: 1, kind, ... }` to `{ version: 1, owner, ... }`
// without bumping the version. A version bump alone would NOT recover
// a SIGKILL'd prior-version leftover (an old body still fails decode
// under any new schema and would block its port forever). Instead the
// recovery is behavioural: `acquirePortReservation` treats an EEXIST
// file it cannot decode as a stale artifact and self-heals it
// (best-effort unlink + retry), so a leftover incompatible reservation
// clears itself on the next allocate of that port.
const PORT_RESERVATION_VERSION = 1 as const;

const PortReservationDocSchema = versionedDocSchema(PORT_RESERVATION_VERSION, {
	port: Schema.Number,
	owner: Schema.String,
	ownerId: Schema.String,
	holder: RosterHolderSchema,
});

type PortReservationDoc = Schema.Schema.Type<typeof PortReservationDocSchema>;

interface PortReservation {
	readonly path: string;
	readonly ownerId: string;
	readonly release: Effect.Effect<void>;
}

type ReservationAttempt =
	| { readonly _tag: 'acquired'; readonly reservation: PortReservation }
	| { readonly _tag: 'busy' }
	| { readonly _tag: 'failed'; readonly detail: string; readonly cause: unknown };

type ReservationWriteAttempt =
	| { readonly _tag: 'written' }
	| { readonly _tag: 'race' }
	| { readonly _tag: 'exists'; readonly doc: PortReservationDoc | null }
	| { readonly _tag: 'failed'; readonly cause: unknown };

const portReservationPath = (root: string, port: number): string =>
	join(root, 'port-locks', `${port}.json`);

const parseReservationDoc = (raw: string): PortReservationDoc | null => {
	try {
		return decodeJsonTextSync(PortReservationDocSchema, raw, {
			source: 'port reservation',
			mkError: (issue) => issue,
		});
	} catch {
		return null;
	}
};

const tryWriteReservationSync = (
	path: string,
	doc: PortReservationDoc,
): ReservationWriteAttempt => {
	// `atomicWriteFileExclusiveSync` writes a tempfile under O_EXCL +
	// fsync, then `linkSync`s it onto the final path. POSIX `link(2)`
	// is atomic AND fails with `EEXIST` if the target exists — that is
	// the exclusive-create primitive `rename` lacks (rename clobbers).
	// A sibling pid that wins the race becomes the canonical reservation
	// at `path`; we observe it via the EEXIST error and surface the
	// winner's doc to the caller (`acquirePortReservation`), which then
	// decides busy-vs-stale based on the holder's liveness.
	try {
		atomicWriteFileExclusiveSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
		return { _tag: 'written' };
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === 'EEXIST') {
			try {
				return { _tag: 'exists', doc: parseReservationDoc(readFileSync(path, 'utf8')) };
			} catch {
				// The winning reservation file was removed between our
				// link-EEXIST and our read (a peer raced release). Retry.
				return { _tag: 'race' };
			}
		}
		return { _tag: 'failed', cause };
	}
};

const unlinkReservationIfOwnerSync = (path: string, ownerId: string): void => {
	try {
		const doc = parseReservationDoc(readFileSync(path, 'utf8'));
		if (doc?.ownerId === ownerId) {
			unlinkSync(path);
		}
	} catch {
		// Missing or unreadable: release is best-effort. A peer never
		// reclaims unreadable reservations; it simply skips that port.
	}
};

const reclaimReservationIfOwnerSync = (path: string, ownerId: string): boolean => {
	try {
		const doc = parseReservationDoc(readFileSync(path, 'utf8'));
		if (doc?.ownerId !== ownerId) return false;
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Best-effort removal of an EXISTING reservation file whose body
 *  cannot be decoded (a leftover from an incompatible-version
 *  supervisor, or a torn write). Such a file carries no readable
 *  `ownerId`/`holder`, so neither `reclaimReservationIfOwnerSync` nor
 *  liveness can ever clear it; without this it would skip that one
 *  port for every future process for the supervisor's lifetime. We
 *  treat an undecodable body as a stale artifact and unlink it so the
 *  next exclusive-create can win. Returns whether the unlink ran
 *  (false if the file vanished first, i.e. a peer already cleared it)
 *  so the caller can bound its retry. */
const reclaimUndecodableReservationSync = (path: string): boolean => {
	try {
		unlinkSync(path);
		return true;
	} catch {
		// Already gone (peer reclaimed it) or unremovable; either way
		// the next loop turn re-evaluates via exclusive-create.
		return false;
	}
};

const acquirePortReservation = (
	root: string,
	port: number,
	owner: string,
): Effect.Effect<ReservationAttempt> =>
	Effect.gen(function* () {
		const path = portReservationPath(root, port);
		const ownerId = `${selfPid()}-${randomUUID().slice(0, 8)}`;
		const holder: RosterHolder = ownHolder();
		const doc: PortReservationDoc = {
			version: PORT_RESERVATION_VERSION,
			port,
			owner,
			ownerId,
			holder,
		};

		// Bounds the self-heal: an undecodable EEXIST body is reclaimed at
		// most once. If we see another undecodable body after that (a peer
		// keeps rewriting garbage), give up with `busy` rather than spin.
		let reclaimedUndecodable = false;
		while (true) {
			const attempt = tryWriteReservationSync(path, doc);
			if (attempt._tag === 'written') {
				return {
					_tag: 'acquired',
					reservation: {
						path,
						ownerId,
						release: Effect.sync(() => unlinkReservationIfOwnerSync(path, ownerId)),
					},
				} as const;
			}
			if (attempt._tag === 'race') continue;
			if (attempt._tag === 'failed') {
				return {
					_tag: 'failed',
					detail: `port reservation ${path} could not be written`,
					cause: attempt.cause,
				} as const;
			}
			if (attempt.doc === null) {
				// EEXIST file we cannot decode (stale incompatible-version
				// leftover or torn write). Self-heal once: unlink it and retry
				// the exclusive-create so a live port is not lost permanently.
				if (!reclaimedUndecodable && reclaimUndecodableReservationSync(path)) {
					reclaimedUndecodable = true;
					continue;
				}
				return { _tag: 'busy' } as const;
			}

			const liveness = yield* checkHolderLiveness(attempt.doc.holder).pipe(
				Effect.catch(() => Effect.succeed('alive' as const)),
			);
			if (liveness === 'alive') return { _tag: 'busy' } as const;
			if (!reclaimReservationIfOwnerSync(path, attempt.doc.ownerId)) {
				return { _tag: 'busy' } as const;
			}
		}
	});

// ----------------------------------------------------------------------
// Service tag + Layer
// ----------------------------------------------------------------------

export class PortBrokerService extends Context.Service<PortBrokerService, PortBroker>()(
	'@devstack/substrate/PortBroker',
) {}

/**
 * Layer that materializes one `PortBroker` per stack scope.
 *
 * The broker's state lives in a `Ref` captured by the Layer's
 * `Effect.gen`; closing the Layer's scope drops every allocation.
 * Parallel stacks each get their own broker (Layer-driven), and they
 * coordinate cross-process via runtime-root reservation files plus the
 * kernel's bind table — never via shared in-process state.
 */
export const layerPortBroker: Layer.Layer<PortBrokerService, never, RuntimeRoot> = Layer.effect(
	PortBrokerService,
	Effect.gen(function* () {
		const runtimeRoot = yield* RuntimeRoot;
		const reservationRoot = runtimeRoot.root;
		const state = yield* Ref.make<State>(new Map());

		const tryReserve = (port: number, owner: string): Effect.Effect<boolean> =>
			Ref.modify<State, boolean>(state, (current) => {
				if (current.has(port)) return [false, current];
				const next = new Map(current);
				next.set(port, { owner });
				return [true, next];
			});

		const drop = (port: number): Effect.Effect<void> =>
			Ref.update(state, (current) => {
				if (!current.has(port)) return current;
				const next = new Map(current);
				next.delete(port);
				return next;
			});

		/** Outcome of one candidate-port attempt.
		 *
		 *  `kept` means `finishAllocation` armed its scope finalizer; the
		 *  in-process slot is now owned by that finalizer and we MUST
		 *  NOT drop it on this critical region's exit. Any other outcome
		 *  (busy / probe-in-use / probe-failed / reservation-failed)
		 *  must release the slot before we hand control back to the
		 *  caller. */
		type SlotOutcome =
			| { readonly _tag: 'kept'; readonly allocated: AllocatedPort }
			| { readonly _tag: 'busy' }
			| {
					readonly _tag: 'reservation-failed';
					readonly detail: string;
					readonly cause: unknown;
			  }
			| { readonly _tag: 'probe-failed'; readonly cause: unknown };

		/** Reserve `port` in the in-process Map, run the probe+reservation
		 *  chain through to either (a) `finishAllocation` arming its scope
		 *  finalizer or (b) a clean release of BOTH the in-process slot
		 *  AND the on-disk reservation file.
		 *
		 *  Interrupt safety: the critical region is wrapped in
		 *  `Effect.acquireUseRelease`, whose `release` step is
		 *  uninterruptible while its `use` step is NOT (Effect v4). The
		 *  acquired `PortReservation` is created INSIDE `use` (after the
		 *  on-disk file is written), so the `use` body stashes it in
		 *  `reservationCell`; the uninterruptible `release` reads that cell
		 *  and unlinks the reservation file on ANY non-`kept` exit —
		 *  interrupt, typed failure, or a non-`kept` success outcome.
		 *  Without this, an interrupt landing between the reservation write
		 *  (in `acquirePortReservation`) and the finalizer arm (in
		 *  `finishAllocation`) left the file on disk while the old release
		 *  only dropped the in-process slot — leaking
		 *  `port-locks/<port>.json`. Its `holder` is this still-alive
		 *  process, so every future `allocate` of that port then saw
		 *  `checkHolderLiveness` report `alive`, marking it busy for the
		 *  whole supervisor lifetime.
		 *
		 *  The only path that intentionally KEEPS both the slot and the
		 *  file is the `kept` outcome, where ownership transfers to the
		 *  scope finalizer (see `finishAllocation`); `reservationCell` is
		 *  cleared there so `release` is a no-op for it.
		 *  (`unlinkReservationIfOwnerSync` is owner-id-guarded and
		 *  idempotent, so a stray double-release is harmless — clearing
		 *  the cell just avoids the redundant stat.)
		 */
		const attemptSlot = (
			port: number,
			owner: string,
			probeHost: PortProbeHost,
		): Effect.Effect<SlotOutcome | null, never, Scope.Scope> => {
			// Visible to BOTH the `use` body (fills it once the reservation
			// file exists) and the uninterruptible `release` callback
			// (unlinks it on any non-`kept` exit). On-disk analogue of the
			// in-process slot.
			let reservationCell: PortReservation | null = null;
			return Effect.acquireUseRelease(
				tryReserve(port, owner),
				(reserved): Effect.Effect<SlotOutcome | null, never, Scope.Scope> => {
					if (!reserved) return Effect.succeed(null);
					return Effect.gen(function* () {
						const reservation = yield* acquirePortReservation(reservationRoot, port, owner);
						if (reservation._tag === 'busy') return { _tag: 'busy' as const };
						if (reservation._tag === 'failed') {
							return {
								_tag: 'reservation-failed' as const,
								detail: reservation.detail,
								cause: reservation.cause,
							};
						}
						// File is now on disk. Hand it to the uninterruptible
						// `release` step so an interrupt at the `probePort` /
						// `finishAllocation` boundary cannot leak it.
						reservationCell = reservation.reservation;
						const ok = yield* probePort(port, probeHost);
						if (ok._tag === 'ok') {
							const allocated = yield* finishAllocation(port, owner, drop, reservation.reservation);
							// Ownership transferred to the scope finalizer; the
							// `release` step must NOT also unlink the file.
							reservationCell = null;
							return { _tag: 'kept' as const, allocated };
						}
						// Probe missed. The uninterruptible `release` step below
						// unlinks the reservation file (via `reservationCell`) and
						// drops the in-process slot, so a single owner cleans up
						// both even if an interrupt preempts us right here.
						if (ok._tag === 'probe-failed') {
							return { _tag: 'probe-failed' as const, cause: ok.cause };
						}
						return { _tag: 'busy' as const };
					});
				},
				(reserved, exit) => {
					// Slot + reservation release (uninterruptible). Drop the
					// in-process entry AND unlink the on-disk reservation
					// UNLESS we transferred ownership to a scope finalizer
					// (the `kept` outcome, which cleared `reservationCell`).
					// Interrupts, typed failures, and non-`kept` success
					// outcomes all flow through here, closing both the Map
					// leak and the port-locks/*.json leak (the on-disk
					// reservation is unlinked here rather than persisting
					// until the supervisor exits).
					if (!reserved) return Effect.void;
					const kept = exit._tag === 'Success' && exit.value?._tag === 'kept';
					if (kept) return Effect.void;
					const releaseReservation =
						reservationCell !== null ? reservationCell.release : Effect.void;
					return Effect.all([drop(port), releaseReservation], { discard: true });
				},
			);
		};

		const allocate: PortBroker['allocate'] = (opts = {}) =>
			Effect.gen(function* () {
				const owner = opts.owner ?? DEFAULT_OWNER;
				const probeHost = opts.probeHost ?? '127.0.0.1';
				const windowStart = opts.windowHint?.start ?? DEFAULT_PORT_WINDOW.start;
				const windowSize = opts.windowHint?.size ?? DEFAULT_PORT_WINDOW.size;

				// 1. Preferred-port path. The broker honours `preferredPort`
				//    as a strong hint, but refuses in-process collisions
				//    (architecture §6: same-stack siblings MUST NOT trample).
				if (opts.preferredPort !== undefined) {
					const outcome = yield* attemptSlot(opts.preferredPort, owner, probeHost);
					if (outcome === null) {
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'preferred-busy',
								detail:
									`preferred port ${opts.preferredPort} (owner=${owner}) is ` +
									`already held by another allocation in this stack`,
							}),
						);
					}
					if (outcome._tag === 'kept') return outcome.allocated;
					if (outcome._tag === 'reservation-failed') {
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'reservation-failed',
								detail: outcome.detail,
								cause: outcome.cause,
							}),
						);
					}
					if (outcome._tag === 'probe-failed') {
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'bind-probe-failed',
								detail:
									`bind probe on preferred port ${opts.preferredPort} ` +
									`(owner=${owner}, host=${probeHost}) failed with non-EADDRINUSE error`,
								cause: outcome.cause,
							}),
						);
					}
					// `busy` (either cross-process reservation held by a
					// live peer OR kernel-level in-use) — fall through to
					// the window scan; the caller's preferred was a HINT.
				}

				// 2. Forward-scan the window.
				for (let p = windowStart; p < windowStart + windowSize; p++) {
					const outcome = yield* attemptSlot(p, owner, probeHost);
					if (outcome === null) continue;
					if (outcome._tag === 'kept') return outcome.allocated;
					if (outcome._tag === 'reservation-failed') {
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'reservation-failed',
								detail: outcome.detail,
								cause: outcome.cause,
							}),
						);
					}
					if (outcome._tag === 'probe-failed') {
						// A privileged port (EACCES) in the middle of the
						// window is unrecoverable for this scan. Surface
						// immediately rather than thrash the whole window.
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'bind-probe-failed',
								detail:
									`bind probe on port ${p} (owner=${owner}, host=${probeHost}) failed ` +
									`with non-EADDRINUSE error`,
								cause: outcome.cause,
							}),
						);
					}
					// `busy` — next candidate.
				}

				return yield* Effect.fail(
					new PortBrokerError({
						reason: 'no-free-port',
						detail:
							`no free port found in [${windowStart}, ` +
							`${windowStart + windowSize}) for owner '${owner}'`,
					}),
				);
			});

		const finishAllocation = (
			port: number,
			owner: string,
			dropFn: (p: number) => Effect.Effect<void>,
			reservation: PortReservation,
		): Effect.Effect<AllocatedPort, never, Scope.Scope> =>
			Effect.gen(function* () {
				// Scope finalizer — drops the entry when the surrounding
				// scope closes. Uninterruptible so a Ctrl-C double-tap
				// doesn't leave the entry dangling in the broker's Ref.
				const release = Effect.all([dropFn(port), reservation.release], {
					discard: true,
				});
				yield* Effect.addFinalizer(() => release.pipe(Effect.uninterruptible));
				yield* Effect.logDebug(`port-broker allocated ${port} (owner=${owner})`);
				return {
					port,
					release,
				} satisfies AllocatedPort;
			});

		return PortBrokerService.of({ allocate });
	}),
);

// ----------------------------------------------------------------------
// Kernel-level bind probe
// ----------------------------------------------------------------------

/** Probe result. `'in-use'` is the recoverable case (try the next
 *  port); `'probe-failed'` is the unrecoverable case (caller's
 *  problem — surface). */
type ProbeResult =
	| { readonly _tag: 'ok' }
	| { readonly _tag: 'in-use' }
	| { readonly _tag: 'probe-failed'; readonly cause: unknown };

/**
 * Bind a transient `net.Server` on `<host>:<port>` and close it.
 * The OS atomically rejects with `EADDRINUSE` if another process
 * already holds the port — that's our cross-process collision check.
 *
 * The default probe is loopback-only because most servers bind
 * loopback. Docker-backed callers pass `0.0.0.0`; on Docker Desktop,
 * binding a transient Node server on `0.0.0.0` does not always reject
 * ports already held on `127.0.0.1`, even though Docker's publish step
 * will reject them. Wildcard probes therefore check loopback as well.
 *
 * Race window: between the probe-close and the caller's real `listen`,
 * a non-devstack process could still grab the port. Devstack peers are
 * blocked by the reservation file until the allocation scope releases.
 */
const probePort = (port: number, host: PortProbeHost): Effect.Effect<ProbeResult> =>
	host === '0.0.0.0'
		? Effect.gen(function* () {
				const loopback = yield* probeSinglePort(port, '127.0.0.1');
				if (loopback._tag !== 'ok') return loopback;
				return yield* probeSinglePort(port, host);
			})
		: probeSinglePort(port, host);

const probeSinglePort = (port: number, host: PortProbeHost): Effect.Effect<ProbeResult> =>
	Effect.callback<ProbeResult>((resume) => {
		let settled = false;
		let server: NetServer | null = null;
		const settle = (r: ProbeResult): void => {
			if (settled) return;
			settled = true;
			resume(Effect.succeed(r));
		};
		try {
			server = createNetServer();
			server.unref();
			const onError = (err: NodeJS.ErrnoException): void => {
				const code = err.code ?? '';
				if (code === 'EADDRINUSE' || code === 'EACCES') {
					// EACCES on these hosts is exotic but treat as in-use
					// for non-privileged ports (our default window starts
					// at 39200, well above 1024). Surfaces as probe-failed
					// only if it persists for every port in the window.
					settle({ _tag: 'in-use' });
				} else {
					settle({ _tag: 'probe-failed', cause: err });
				}
				try {
					server?.close();
				} catch {
					/* defensive */
				}
			};
			server.once('error', onError);
			server.listen(port, host, () => {
				// Verify the OS actually gave us THIS port (defensive —
				// asking for a specific port shouldn't ever surprise
				// us, but `address()` is the source of truth).
				const addr = server?.address() as AddressInfo | null;
				const ok = addr !== null && addr.port === port;
				server?.close(() => {
					settle(ok ? { _tag: 'ok' } : { _tag: 'in-use' });
				});
			});
		} catch (cause) {
			settle({ _tag: 'probe-failed', cause });
			try {
				server?.close();
			} catch {
				/* defensive */
			}
		}
		// Interrupt mid-`listen()` must close the transient server so the
		// probed port isn't held open by an orphaned handle.
		return Effect.sync(() => {
			try {
				server?.close();
			} catch {
				/* defensive */
			}
		});
	});
