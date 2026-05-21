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
//   2. Verifies kernel-level availability by binding a transient
//      `net.Server` on the candidate port and closing it.
//      The OS's `EADDRINUSE` is the cross-process collision check —
//      another devstack on the same machine that holds the port
//      surfaces here as a probe failure and the broker moves on.
//   3. Releases on scope close. The broker hands back a `release`
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
// Cross-process safety: kernel bind-probe + the stack-scoped supervisor
// lock (`stackLockFile`) — two parallel devstacks on the same machine
// CAN both call the broker concurrently because each runs its own
// in-process `Ref`; the bind-probe is the cross-process check. Per the
// architecture §6 parallel-stacks story, the file-locked stack-scope
// upstream of the broker keeps two acquires of the SAME stack
// serialized; the broker itself only needs to defend in-process
// collisions.

import { Context, Effect, Layer, Ref, Scope } from 'effect';
import {
	createServer as createNetServer,
	type AddressInfo,
	type Server as NetServer,
} from 'node:net';

import { PortBrokerError } from '../errors.ts';

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
export type PortKind = 'wallet' | 'http' | 'rpc' | 'misc';

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
	 * across processes (kernel bind-probe on `probeHost`).
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
 * coordinate cross-process via the kernel's bind table — never via
 * shared in-process state.
 */
export const layerPortBroker: Layer.Layer<PortBrokerService> = Layer.effect(
	PortBrokerService,
	Effect.gen(function* () {
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
					const ok = yield* probePort(opts.preferredPort, probeHost);
					if (ok._tag === 'ok') {
						return yield* finishAllocation(opts.preferredPort, opts.kind, drop);
					}
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

				// 2. Forward-scan the kind window.
				for (let p = range.start; p < range.start + range.window; p++) {
					const reserved = yield* tryReserve(p, opts.kind, owner);
					if (!reserved) continue;
					const ok = yield* probePort(p, probeHost);
					if (ok._tag === 'ok') {
						return yield* finishAllocation(p, opts.kind, drop);
					}
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
		): Effect.Effect<AllocatedPort, never, Scope.Scope> =>
			Effect.gen(function* () {
				// Scope finalizer — drops the entry when the surrounding
				// scope closes. Uninterruptible so a Ctrl-C double-tap
				// doesn't leave the entry dangling in the broker's Ref.
				yield* Effect.addFinalizer(() => dropFn(port).pipe(Effect.uninterruptible));
				yield* Effect.annotateCurrentSpan({
					'portBroker.port': port,
					'portBroker.kind': kind,
				});
				yield* Effect.logDebug(`port-broker allocated ${port} (kind=${kind})`);
				return {
					port,
					kind,
					release: dropFn(port),
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
 * loopback. Docker-backed callers pass `0.0.0.0`, matching Docker's
 * default host publish semantics and catching ports occupied on any
 * local interface.
 *
 * Race window: between the probe-close and the caller's real
 * `listen`, another process could grab the port. Acceptable on dev
 * machines (rare; the real `listen` will surface EADDRINUSE clearly).
 * The in-process Ref blocks the more-likely sibling-plugin race.
 */
const probePort = (port: number, host: PortProbeHost): Effect.Effect<ProbeResult> =>
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
	}).pipe(Effect.withSpan('substrate.portBroker.probe', { attributes: { host, port } }));
