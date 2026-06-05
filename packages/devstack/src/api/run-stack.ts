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
// non-public boot-injection seam the CLI `up` verb routes through (S3) —
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

/** Programmatic handle. Symmetric with the attached CLI surface:
 *  `events`, `state`, and `awaitShutdown` are the same primitives the
 *  TUI consumes in-process. */
export interface RunHandle {
	/** Boot the supervisor and resolve when every plugin reaches
	 *  `ready`. Fails with `BootError` if any plugin's acquire path
	 *  fails. */
	readonly start: Effect.Effect<void, BootError, never>;
	/** Trigger graceful shutdown: enqueues `shutdown.requested` onto
	 *  the supervisor's command channel, then awaits the fiber. */
	readonly stop: Effect.Effect<void, never, never>;
	/** Resolve when the supervisor fiber exits. Succeeds on a clean
	 *  shutdown; fails with the captured `Cause` if the supervisor died
	 *  mid-run after boot completed (e.g. a plugin scope finalizer
	 *  defect). Boot-time failures still surface via `start`. */
	readonly awaitShutdown: Effect.Effect<void, unknown, never>;
	/** Tail of typed engine events from the supervisor's hub. The
	 *  upstream is a `Queue.Dequeue`; consume via `Stream.run...`. */
	readonly events: Stream.Stream<EngineEvent, never, never>;
	/** The supervisor's live projection. Renderers + tests read this
	 *  directly; changes flow through `SubscriptionRef.changes`. */
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
	/** Enqueue side of the supervisor's command channel — the same queue
	 *  the supervisor consumes. An in-process TUI / out-of-process IPC
	 *  bridge publishes `EngineCommand`s here (`shutdown.requested`,
	 *  `selective-restart.requested`, snapshot verbs, …). The signal
	 *  handler and the `stop` bridge already publish onto this queue. */
	readonly commands: Queue.Enqueue<EngineCommand>;
	/** Submit-and-await dispatch: offers `command` onto the supervisor's
	 *  in-band command queue and resolves when the command-loop finishes
	 *  it (re-failing with the handler's cause). The IPC layer adds ack
	 *  correlation on top of this later. */
	readonly runCommand: (command: EngineCommand) => Effect.Effect<void, unknown, never>;
	/** The resolved `Identity` (app / stack / chain) this handle booted
	 *  with. Available synchronously, before `start`. */
	readonly identity: Identity;
}

// -----------------------------------------------------------------------------
// runStack
// -----------------------------------------------------------------------------

/**
 * Boot a `Stack` for programmatic embedding. Returns a `RunHandle`
 * synchronously; the supervisor fiber is forked on `start`.
 *
 * Lifecycle:
 *
 *   1. `runStack(stack, opts)` — synchronous; no fiber forked yet.
 *   2. `await Effect.runPromise(handle.start)` — forks the supervisor,
 *      blocks until every plugin reaches `ready` (or fails with
 *      `BootError`).
 *   3. Use `handle.events` / `handle.state` to observe.
 *   4. `await Effect.runPromise(handle.stop)` — graceful shutdown.
 *   5. `handle.awaitShutdown` resolves once finalizers complete.
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
