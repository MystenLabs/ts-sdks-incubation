// `runStack(stack, opts?)` — top-level programmatic embedding.
//
// `defineDevstack(...)` returns a static `Stack<Members>` manifest with
// no runnable surface. Library consumers (vitest setup, custom hosts,
// Effect-native apps, embedded fixtures) would otherwise have to
// re-implement `cli/wirings/up.ts:runUpLive`'s substrate Layer composition.
// `runStack` is the single embedder seam — it consumes the same
// `orchestrators/boot.ts` helpers the CLI consumes. See
// ARCHITECTURE.md §"Layer composition lives at L3, not L0".
//
// This module is the THIN PUBLIC FACADE. The implementation — plus the
// non-public boot-injection seam the CLI `up` verb routes through —
// lives in `run-stack-internal.ts`. `runStack` delegates there with a
// zero-`boot` bag, so the public surface (`RunHandle`, `RunStackOptions`,
// `BootError`) and the zero-`boot` path stay byte-identical. The substrate
// types on the internal seam (`InternalRunHandle`, the bag, the
// `SupervisorHandle`) NEVER reach this public surface or `index.ts`.
//
// Shape:
//
// ```ts
// const stack = defineDevstack(...);
// const handle = runStack(stack, { runtimeRoot: '/tmp/devstack' });
// await Effect.runPromise(handle.start);
// // ... interact ...
// await Effect.runPromise(handle.stop);
// await Effect.runPromise(handle.awaitShutdown);
// ```
//
// `start` resolves when every plugin has reached `ready` (or when one
// fails to acquire — `start` then fails with `BootError`). `stop`
// triggers graceful shutdown; `awaitShutdown` resolves when the fiber
// finishes its scope finalizers.

import type { Cause, Context, Effect, Queue, Scope, Stream, SubscriptionRef } from 'effect';

import type { Identity } from '../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import type { ProductionCodegenOptions } from '../orchestrators/boot.ts';
import type { Stack } from './define-devstack.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';
import { runStackWithBoot } from './run-stack-internal.ts';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Identity overrides for `runStack`. App and stack fall back through
 *  shared package metadata inference after their env overrides. */
export interface RunStackIdentityOptions {
	readonly app?: string;
	readonly stack?: string;
	readonly network?: string;
}

export interface RunStackOptions {
	/** Identity overrides — falls back to env + library defaults. */
	readonly identity?: RunStackIdentityOptions;
	/** User application root. Codegen defaults to `<appRoot>/src/generated`.
	 *  Defaults to `process.cwd()`. */
	readonly appRoot?: string;
	/** Codegen output overrides for embedded tests or custom app layout. */
	readonly codegen?: Omit<ProductionCodegenOptions, 'appRoot'>;
	/** Filesystem root under which the substrate stores per-stack
	 *  artifacts (cache, snapshots, manifest, projection, etc.).
	 *  Precedence: `runtimeRoot` > `stateDir` (this option or
	 *  `DevstackOptions.stateDir` on the stack) > `$DEVSTACK_STATE_DIR`
	 *  > `<cwd>/.devstack`. */
	readonly runtimeRoot?: string;
	/** Sibling of `runtimeRoot` — the `DevstackOptions.stateDir` field
	 *  threaded through `runStack` so a stack-level default can be
	 *  overridden per-embedding without forcing every call site to
	 *  flip between `runtimeRoot` and `stateDir`. Same semantics as
	 *  `runtimeRoot`; lower precedence. */
	readonly stateDir?: string;
	/** Extend the plugin execution context after built-in plugin
	 *  services are installed. Use this for custom plugin-author
	 *  services or logger overrides. */
	readonly extendContext?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, Scope.Scope>;
}

/** Boot error surfaced by `RunHandle.start`. Wraps the supervisor's
 *  startup failure tree for cascade-formatter rendering. */
export interface BootError {
	readonly _tag: 'BootError';
	readonly cause: Cause.Cause<unknown>;
}

/**
 * The programmatic handle `runStack` returns. It is a small bag of Effect
 * values + readable refs — a functional surface, not an object with methods:
 * each lifecycle action (`start` / `stop` / `awaitShutdown`) is an
 * `Effect` you run, and each observation channel (`events` / `state`) is a
 * value you read. Returned synchronously, BEFORE any fiber is forked, so a
 * caller can subscribe to `state` / `events` ahead of `start`.
 *
 * Symmetric with the attached CLI surface: `events`, `state`, and
 * `awaitShutdown` are the SAME in-process primitives the TUI consumes.
 *
 * Typical use:
 *
 *   const handle = runStack(stack, opts);
 *   await Effect.runPromise(handle.start);          // boot → all ready
 *   const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
 *   await Effect.runPromise(handle.stop);           // graceful shutdown
 *   await Effect.runPromise(handle.awaitShutdown);  // finalizers done
 */
export interface RunHandle {
	/** Fork the supervisor fiber and resolve once EVERY plugin reaches
	 *  `ready` (or a terminal `done`). Fails with `BootError` if any
	 *  plugin's initial-acquire path fails. Idempotent: a second `start`
	 *  is a no-op that just awaits the same boot gate. */
	readonly start: Effect.Effect<void, BootError, never>;
	/** Request graceful shutdown: publishes `shutdown.requested` onto the
	 *  supervisor's command channel (driving scope finalizers), then awaits
	 *  the fiber. Safe to call before `start` (returns immediately) and
	 *  more than once. */
	readonly stop: Effect.Effect<void, never, never>;
	/** Resolve when the supervisor fiber exits. Succeeds on a clean
	 *  shutdown; fails with the captured `Cause` if the supervisor died
	 *  mid-run AFTER boot completed (e.g. a plugin scope-finalizer defect).
	 *  Boot-time failures surface via `start`, not here — so a host that
	 *  blocks the process on this Effect stays up for the supervisor's
	 *  whole lifetime and learns of a post-boot death. */
	readonly awaitShutdown: Effect.Effect<void, unknown, never>;
	/** Tail of typed engine events off the supervisor's hub. SINGLE
	 *  CONSUMER: the upstream is a `Queue.Dequeue`, so taking an event
	 *  removes it — running this stream from two places SPLITS the events
	 *  between them rather than fanning out. Consume it once (e.g. via
	 *  `Stream.runForEach`) and tee downstream if you need multiple sinks.
	 *  Empty until `start` wires the hub. */
	readonly events: Stream.Stream<EngineEvent, never, never>;
	/** The supervisor's live projection — the single read-model of stack
	 *  state (identity, per-plugin lifecycle, cycle phase, log tail). Live
	 *  for the supervisor's whole process lifetime: snapshot it with
	 *  `SubscriptionRef.get`, or observe updates via `SubscriptionRef.changes`.
	 *  Renderers + tests read it directly; nothing writes through it. */
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
	/** Fire-and-forget publish side of the supervisor's command channel —
	 *  enqueue an `EngineCommand` (`shutdown.requested`,
	 *  `selective-restart.requested`, snapshot/wipe/prune verbs, …) and
	 *  return immediately. The same queue the supervisor drains; the signal
	 *  handler and the `stop` bridge publish here too. Use `runCommand` when
	 *  you need to await the command's outcome. */
	readonly commands: Queue.Enqueue<EngineCommand>;
	/** Submit-and-AWAIT dispatch: publishes `command` in-band on the
	 *  supervisor's command loop and resolves when the loop finishes
	 *  handling it, re-failing with the handler's cause. Use this (over
	 *  `commands`) when the caller must know the command succeeded —
	 *  e.g. a destructive `snapshot.restore`. (The cross-process IPC bridge
	 *  layers ack-correlation on top of this.) */
	readonly runCommand: (command: EngineCommand) => Effect.Effect<void, unknown, never>;
	/** The resolved `Identity` — app / stack / network — this handle booted
	 *  with, after all option > env > inference resolution. Available
	 *  synchronously, BEFORE `start`. */
	readonly identity: Identity;
}

// -----------------------------------------------------------------------------
// runStack
// -----------------------------------------------------------------------------

/**
 * Boot a `Stack` for programmatic embedding. Returns a `RunHandle`
 * synchronously; the supervisor fiber is forked on `start`.
 *
 * Programmatic contract — call, then drive the returned handle's Effects:
 *
 *   1. `runStack(stack, opts)` — synchronous; NO fiber forked yet. Safe to
 *      read `handle.identity` and subscribe to `handle.state` /
 *      `handle.events` right away.
 *   2. `await Effect.runPromise(handle.start)` — forks the supervisor and
 *      blocks until every plugin reaches `ready` (or fails with `BootError`).
 *   3. Observe via `handle.state` (snapshot / changes) and `handle.events`
 *      (single-consumer tail); drive via `handle.commands` /
 *      `handle.runCommand`.
 *   4. `await Effect.runPromise(handle.stop)` — graceful shutdown.
 *   5. `await Effect.runPromise(handle.awaitShutdown)` — resolves once scope
 *      finalizers complete (or re-raises a post-boot supervisor death).
 *
 * Thin facade: delegates to `runStackWithBoot` (in `run-stack-internal.ts`)
 * with a zero-`boot` bag and no `commandHandler`, so this public path is
 * byte-identical to the pre-seam `runStack` body. The boot-injection seam
 * the CLI `up` verb consumes is non-public — it is NOT re-exported from
 * `index.ts`, and its substrate types never appear on `RunHandle`.
 */
export const runStack = (
	stack: Stack<ReadonlyArray<AnyPlugin>>,
	opts: RunStackOptions = {},
): RunHandle => runStackWithBoot(stack, { ...opts, commandHandler: undefined, boot: undefined });
