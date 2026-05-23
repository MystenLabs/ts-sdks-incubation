// Port broker — substrate-level service.
//
// Architecture (`notes/redesign/architecture.md` § "What's collapsed"):
// resource broker for host ports. Plugins that need to bind a host
// HTTP server (wallet) or publish a container port on the host (Sui)
// yield this service and call
// `allocate({...})`. The broker:
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
// "Kind-window" sequential search: each `kind` has its own starting
// port and window size (`PORT_RANGES`). The broker scans forward from
// `start` up to `start + window` (and from `preferredPort` if
// supplied) until a probe succeeds.
//
// Cross-process safety: the reservation file is scoped to the runtime
// root, not the stack root, because host ports are machine-global. The
// stack-scoped supervisor lock serializes acquires of the SAME stack;
// these reservation files serialize host-port choices across DIFFERENT
// stacks and apps that share a state dir.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
	createServer as createNetServer,
	type AddressInfo,
	type Server as NetServer,
} from 'node:net';
import { dirname, join } from 'node:path';

import { Context, Effect, Layer, Ref, Schema, Scope } from 'effect';

import { RosterHolderSchema, type RosterHolder } from '../../cross-process.ts';
import { checkHolderLiveness, ownHolder } from '../cross-process/liveness.ts';
import { PortBrokerError } from '../errors.ts';
import { RuntimeRoot } from '../paths.ts';
import { decodeJsonTextSync } from '../runtime-decode.ts';

// ----------------------------------------------------------------------
// Public shape
// ----------------------------------------------------------------------

/** Allocation kind — drives the search-window starting port. Plugins
 *  pass a literal so a `wallet` allocation and a `rpc` allocation
 *  never collide on the same starting point.
 *
 *  Extend `PORT_RANGES` below to add a new kind. The literal type is
 *  closed deliberately — agnostic-naming would invite plugins to
 *  freelance kinds (and overlap window starts unintentionally).
 *
 *  Today's windows are sized for "tens of plugins per stack" with
 *  parallel-stack overhead headroom. Each window is 1000 ports; that's
 *  more than enough for any realistic in-process devstack, and the
 *  forward-scan only ever crosses a window boundary if EVERY port in
 *  the window is taken (effectively never on dev machines). */
const PORT_KINDS = ['wallet', 'http', 'rpc', 'misc'] as const;

export type PortKind = (typeof PORT_KINDS)[number];

/** Host interface used by the transient bind probe. Callers binding a
 *  real server on loopback should use the default. Callers that hand
 *  the port to Docker's all-interface publish path should pass
 *  `'0.0.0.0'` so the probe asks the same kernel question. */
export type PortProbeHost = '127.0.0.1' | '0.0.0.0';

/** Sequential search window per kind. The broker tries `preferredPort`
 *  first (if given), then `[start, start + window)` in order. */
const PORT_RANGES: Readonly<Record<PortKind, { readonly start: number; readonly window: number }>> =
	{
		// 39200 — chosen to land between the wallet's legacy 39082 default
		// (still functional via `preferredPort`) and the high ephemeral
		// range. Stays clear of common dev-server defaults (3000-5173, 8000-
		// 8080) so a sibling Vite / Next.js process on the host doesn't
		// accidentally collide on the first probe.
		wallet: { start: 39200, window: 1000 },
		// 50000 — well clear of postgres (5432), redis (6379), and the
		// Vite/Next dev-server cluster. Used by any plugin that just wants
		// "a free HTTP port".
		http: { start: 50000, window: 1000 },
		// 51000 — reserved for RPC-shaped servers (graphql, custom RPC).
		// Kept distinct from `http` so the kind-window discrimination
		// surfaces in `ss -ltnp` listings during diagnosis.
		rpc: { start: 51000, window: 1000 },
		// 52000 — escape hatch for plugins that don't fit the typed kinds.
		misc: { start: 52000, window: 1000 },
	};

/** Input to `allocate`. */
export interface AllocateOptions {
	/** Optional caller hint. The broker tries this FIRST; if the port is
	 *  already held in-process the call FAILS with
	 *  `reason: 'preferred-busy'` (the caller asked specifically for
	 *  this port and got an obvious collision). If the bind-probe fails
	 *  with EADDRINUSE the broker falls through to the kind-window
	 *  scan — preferred is a HINT for the kernel-collision case, but a
	 *  HARD CHOICE against in-process collision. */
	readonly preferredPort?: number;
	/** Interface to bind during the kernel probe. Defaults to
	 *  `127.0.0.1`, matching host-loopback servers such as the wallet.
	 *  Docker `-p host:container` publishes on all interfaces, so
	 *  Docker-backed callers pass `0.0.0.0`. */
	readonly probeHost?: PortProbeHost;
	/** Allocation kind — drives the search window when no preferred is
	 *  supplied (or when preferred is taken at the kernel level). */
	readonly kind: PortKind;
}

/** Successful allocation. `release` is provided in addition to the
 *  scope finalizer so tests / orchestrators can drive release
 *  explicitly without unwinding the whole scope. Calling `release`
 *  twice is a no-op. */
export interface AllocatedPort {
	readonly port: number;
	readonly kind: PortKind;
	readonly release: Effect.Effect<void>;
}

/** Service shape — what plugins yield from Context. */
export interface PortBroker {
	/**
	 * Allocate a port for `kind`. The returned port is exclusive within
	 * THIS process (the broker's `Ref` map) and best-effort-exclusive
	 * across devstack processes that share a runtime root (port
	 * reservation file), then verified against the kernel bind table
	 * on `probeHost`.
	 *
	 * Scope-bound release: the broker installs a finalizer on the
	 * surrounding scope; callers can additionally invoke
	 * `result.release` explicitly.
	 *
	 * Failures (`PortBrokerError`):
	 *   - `preferred-busy` — caller's `preferredPort` is held by another
	 *     in-process allocation on the same stack.
	 *   - `no-free-port` — the kind window was exhausted without a
	 *     probe-pass candidate.
	 *   - `bind-probe-failed` — non-EADDRINUSE error from the OS bind
	 *     probe (EACCES on a privileged port etc.).
	 *   - `reservation-failed` — port reservation file IO failed.
	 */
	readonly allocate: (
		opts: AllocateOptions,
	) => Effect.Effect<AllocatedPort, PortBrokerError, Scope.Scope>;
}

// ----------------------------------------------------------------------
// Internal state
// ----------------------------------------------------------------------

/** In-process holder for a port. Carries the kind for diagnostics
 *  (e.g. surfaced in `no-free-port` errors). The `owner` is a
 *  free-form caller string used for log lines and the future cause
 *  walker; today every caller passes the literal `kind`. */
interface Holder {
	readonly kind: PortKind;
	readonly owner: string;
}

type State = ReadonlyMap<number, Holder>;

const PORT_RESERVATION_VERSION = 1 as const;

const PortReservationDocSchema = Schema.Struct({
	version: Schema.Literal(PORT_RESERVATION_VERSION),
	port: Schema.Number,
	kind: Schema.Literals(PORT_KINDS),
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
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(doc)}\n`, { flag: 'wx', mode: 0o600 });
		return { _tag: 'written' };
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code !== 'EEXIST') return { _tag: 'failed', cause };
		if (!existsSync(path)) return { _tag: 'race' };
		try {
			return { _tag: 'exists', doc: parseReservationDoc(readFileSync(path, 'utf8')) };
		} catch {
			return { _tag: 'exists', doc: null };
		}
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

const acquirePortReservation = (
	root: string,
	port: number,
	kind: PortKind,
): Effect.Effect<ReservationAttempt> =>
	Effect.gen(function* () {
		const path = portReservationPath(root, port);
		const ownerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
		const holder: RosterHolder = ownHolder();
		const doc: PortReservationDoc = {
			version: PORT_RESERVATION_VERSION,
			port,
			kind,
			ownerId,
			holder,
		};

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
			if (attempt.doc === null) return { _tag: 'busy' } as const;

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
	'@devstack-rewrite/substrate/PortBroker',
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

		const tryReserve = (port: number, kind: PortKind, owner: string): Effect.Effect<boolean> =>
			Ref.modify<State, boolean>(state, (current) => {
				if (current.has(port)) return [false, current];
				const next = new Map(current);
				next.set(port, { kind, owner });
				return [true, next];
			});

		const drop = (port: number): Effect.Effect<void> =>
			Ref.update(state, (current) => {
				if (!current.has(port)) return current;
				const next = new Map(current);
				next.delete(port);
				return next;
			});

		const allocate: PortBroker['allocate'] = (opts) =>
			Effect.gen(function* () {
				const range = PORT_RANGES[opts.kind];
				const owner = opts.kind;
				const probeHost = opts.probeHost ?? '127.0.0.1';

				// 1. Preferred-port path. The broker honours `preferredPort`
				//    as a strong hint, but refuses in-process collisions
				//    (architecture §6: same-stack siblings MUST NOT trample).
				if (opts.preferredPort !== undefined) {
					const reserved = yield* tryReserve(opts.preferredPort, opts.kind, owner);
					if (!reserved) {
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'preferred-busy',
								detail:
									`preferred port ${opts.preferredPort} (${opts.kind}) is ` +
									`already held by another allocation in this stack`,
							}),
						);
					}
					// Kernel-level probe. If a foreign process holds the
					// port, drop our reservation and FALL THROUGH to the
					// kind-window scan — the caller's preferred was a HINT
					// for cross-process collisions.
					const reservation = yield* acquirePortReservation(
						reservationRoot,
						opts.preferredPort,
						opts.kind,
					);
					if (reservation._tag === 'busy') {
						yield* drop(opts.preferredPort);
					} else if (reservation._tag === 'failed') {
						yield* drop(opts.preferredPort);
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'reservation-failed',
								detail: reservation.detail,
								cause: reservation.cause,
							}),
						);
					} else {
						const ok = yield* probePort(opts.preferredPort, probeHost);
						if (ok._tag === 'ok') {
							return yield* finishAllocation(
								opts.preferredPort,
								opts.kind,
								drop,
								reservation.reservation,
							);
						}
						yield* reservation.reservation.release;
						yield* drop(opts.preferredPort);
						if (ok._tag === 'probe-failed') {
							return yield* Effect.fail(
								new PortBrokerError({
									reason: 'bind-probe-failed',
									detail:
										`bind probe on preferred port ${opts.preferredPort} ` +
										`(${opts.kind}, host=${probeHost}) failed with non-EADDRINUSE error`,
									cause: ok.cause,
								}),
							);
						}
						// `ok._tag === 'in-use'` — fall through to scan.
					}
				}

				// 2. Forward-scan the kind window.
				for (let p = range.start; p < range.start + range.window; p++) {
					const reserved = yield* tryReserve(p, opts.kind, owner);
					if (!reserved) continue;
					const reservation = yield* acquirePortReservation(reservationRoot, p, opts.kind);
					if (reservation._tag === 'busy') {
						yield* drop(p);
						continue;
					}
					if (reservation._tag === 'failed') {
						yield* drop(p);
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'reservation-failed',
								detail: reservation.detail,
								cause: reservation.cause,
							}),
						);
					}
					const ok = yield* probePort(p, probeHost);
					if (ok._tag === 'ok') {
						return yield* finishAllocation(p, opts.kind, drop, reservation.reservation);
					}
					yield* reservation.reservation.release;
					yield* drop(p);
					if (ok._tag === 'probe-failed') {
						// A privileged port (EACCES) in the middle of the
						// window is unrecoverable for this kind. Surface
						// immediately rather than thrash the whole window.
						return yield* Effect.fail(
							new PortBrokerError({
								reason: 'bind-probe-failed',
								detail:
									`bind probe on port ${p} (${opts.kind}, host=${probeHost}) failed ` +
									`with non-EADDRINUSE error`,
								cause: ok.cause,
							}),
						);
					}
					// In-use → next candidate.
				}

				return yield* Effect.fail(
					new PortBrokerError({
						reason: 'no-free-port',
						detail:
							`no free port found in [${range.start}, ` +
							`${range.start + range.window}) for kind '${opts.kind}'`,
					}),
				);
			}).pipe(
				Effect.withSpan('substrate.portBroker.allocate', {
					attributes: {
						kind: opts.kind,
						preferredPort: opts.preferredPort ?? -1,
						probeHost: opts.probeHost ?? '127.0.0.1',
					},
				}),
			);

		const finishAllocation = (
			port: number,
			kind: PortKind,
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
				yield* Effect.annotateCurrentSpan({
					'portBroker.port': port,
					'portBroker.kind': kind,
				});
				yield* Effect.logDebug(`port-broker allocated ${port} (kind=${kind})`);
				return {
					port,
					kind,
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
 * The default probe is loopback-only because the wallet binds
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
			}).pipe(Effect.withSpan('substrate.portBroker.probe', { attributes: { host, port } }))
		: probeSinglePort(port, host).pipe(
				Effect.withSpan('substrate.portBroker.probe', { attributes: { host, port } }),
			);

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
					// for non-privileged ports (our windows start at
					// 39200, well above 1024). Surfaces as probe-failed
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
	});
