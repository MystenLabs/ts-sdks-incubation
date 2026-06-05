// Typed event stream + command channel taxonomy.
//
// Architecture § Event stream / Command stream. One shape, one
// channel. Surfaces subscribe; the engine publishes. Closed sums —
// adding a tag requires an architecture revision so the renderer
// vocabulary stays disciplined.

import type { EndpointKey, PluginKey } from './brand.ts';
import type { LifecycleStatus, PhaseNarration } from './lifecycle.ts';
import type { BuildEntry, Endpoint, StructuredError } from './projection.ts';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

/** Typed lifecycle event stream. Architecture-enumerated categories. */
export type EngineEvent =
	| {
			readonly tag: 'lifecycle.statusChanged';
			readonly pluginKey: PluginKey;
			readonly from: LifecycleStatus;
			readonly to: LifecycleStatus;
			readonly at: number;
	  }
	| {
			readonly tag: 'lifecycle.phaseSet';
			readonly pluginKey: PluginKey;
			readonly phase: PhaseNarration | null;
			readonly at: number;
	  }
	| {
			readonly tag: 'log.appended';
			readonly pluginKey: PluginKey;
			readonly line: string;
			readonly level: 'info' | 'warn' | 'error';
			readonly at: number;
	  }
	| {
			readonly tag: 'endpoint.registered';
			readonly endpoint: Endpoint;
	  }
	| {
			/** Name-blind projection update. Plugins emit this with a
			 *  `kind` discriminator the L3 projection orchestrator (today:
			 *  the reducer in `runtime/projection/update.ts`) decodes
			 *  per-kind. Substrate stays unaware of which plugins produce
			 *  which projection shapes — the kind→decoder mapping is owned
			 *  by the consuming orchestrator. */
			readonly tag: 'projection.updated';
			readonly kind: string;
			readonly key: string;
			readonly payload: unknown;
			readonly at: number;
	  }
	| {
			readonly tag: 'endpoint.released';
			readonly endpointKey: EndpointKey;
			readonly at: number;
	  }
	| {
			readonly tag: 'strategy.registered';
			readonly capabilityKey: string;
			readonly autoMounted: boolean;
			readonly at: number;
	  }
	| {
			readonly tag: 'strategy.unregistered';
			readonly capabilityKey: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'manifest.flushed';
			readonly manifestVersion: number;
			readonly at: number;
	  }
	| {
			readonly tag: 'codegen.emitted';
			readonly files: ReadonlyArray<string>;
			readonly at: number;
	  }
	| {
			readonly tag: 'error.reported';
			readonly error: StructuredError;
	  }
	| {
			readonly tag: 'build.statusChanged';
			readonly entry: BuildEntry;
	  }
	| {
			readonly tag: 'restart.requested';
			readonly target: 'stack' | { readonly pluginKey: PluginKey };
			readonly at: number;
	  }
	| {
			readonly tag: 'restart.completed';
			readonly target: 'stack' | { readonly pluginKey: PluginKey };
			readonly at: number;
	  }
	| {
			readonly tag: 'shutdown.escalated';
			readonly signal: ShutdownSignal;
			readonly exitCode: number;
			readonly at: number;
	  }
	| {
			readonly tag: 'snapshot.captureSkipped';
			readonly reason: 'already-running';
			readonly snapshotId: string;
			readonly name?: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'snapshot.captureFailed';
			readonly snapshotId: string;
			readonly name?: string;
			readonly summary: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'snapshot.captured';
			readonly snapshotId: string;
			readonly name?: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'snapshot.restored';
			readonly snapshotId: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'engine.orchestrator.dispatchFailed';
			readonly pluginKey: PluginKey;
			readonly kind: string;
			readonly message: string;
			/** Underlying-cause discriminator (the failing sink error's
			 *  `_tag`, e.g. `RouterBootFailed`) when one is recoverable
			 *  from the wrapped cause. Optional + additive: omitted when
			 *  the cause carries no tag, so the closed-sum vocabulary is
			 *  unchanged for consumers that ignore it. Surfaced so an
			 *  operator can tell WHICH orchestrator sink broke (dead RPC
			 *  routing vs codegen collision) without parsing the message. */
			readonly causeType?: string;
			readonly at: number;
	  };

/** Typed command channel. Surfaces publish; the engine consumes.
 *  Same shape regardless of producer (CLI argv / TUI keypress /
 *  programmable API). */
export type EngineCommand =
	| { readonly tag: 'stack.start' }
	| { readonly tag: 'stack.stop' }
	| { readonly tag: 'stack.restart' }
	| { readonly tag: 'apply.requested'; readonly pluginKey?: PluginKey }
	| { readonly tag: 'codegen.requested' }
	| { readonly tag: 'snapshot.capture'; readonly snapshotId?: string; readonly name?: string }
	| { readonly tag: 'snapshot.restore'; readonly snapshotId: string }
	| { readonly tag: 'snapshot.list' }
	| { readonly tag: 'snapshot.delete'; readonly snapshotId: string }
	| { readonly tag: 'wipe.requested' }
	| { readonly tag: 'prune.requested' }
	| { readonly tag: 'advance-clock.requested'; readonly toMillis: number }
	| { readonly tag: 'shutdown.requested' }
	| {
			readonly tag: 'shutdown.hardKillRequested';
			readonly signal: ShutdownSignal;
			readonly exitCode: number;
			readonly at: number;
	  }
	| {
			readonly tag: 'selective-restart.requested';
			readonly pluginKey: PluginKey;
	  };
