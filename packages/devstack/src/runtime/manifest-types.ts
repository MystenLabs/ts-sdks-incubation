// Pure-type module for the Manifest schema. Lives separate from
// `manifest-writer.ts` so consumers (frontend, React adapter, vite
// plugin) can import the type without pulling node-fs into their type
// graph. The writer/reader files import from here too.

import type { Network } from '../core/types.js';

export interface Manifest {
	app: string;
	network: Network;
	emittedAt: string;
	registry: SerializedRegistry;
	/** Per-action state: the input hash + last successful run timestamp.
	 *
	 * Hydrated into `Reconciler.state` at supervisor / one-shot startup so
	 * cold-cycle skip predicates work without re-running getStatus. The
	 * reconciler's contract is "skip when hash matches"; without persisted
	 * state, a fresh process can't know the hash matched. With persistence,
	 * setup actions (Publish / Register / Seed / Emit / Build) skip on
	 * input-hash match alone — `getStatus` is reserved for liveness probes
	 * (Service / HostProcess) and invariant checks (Verify).
	 *
	 * Keys are fully-qualified action names (`<plugin>.<action>`); values
	 * are the same shape the in-memory `ActionState` uses. */
	actionStates?: Record<string, SerializedActionState>;
}

export interface SerializedActionState {
	lastInputHash: string;
	lastRunAt?: number;
}

export interface SerializedRegistry {
	tokens: unknown[];
	packages: unknown[];
	accounts: unknown[];
	services: unknown[];
	[namespace: string]: unknown;
}
