// `devstack(...refs)` — the canonical Phase-2 entry. Variadic over Refs
// (and arrays of Refs from composite factories like `Deepbook(...)`),
// flattens to a single `StackMember[]`, runs the default-provider fill
// step, then delegates to `defineDevstack(...)`. Auto-includes
// `manifest()` so the v3 sidecar still lands on disk; Phase 6 swaps
// this for `emitManifestV4()`.

import type { Effect } from 'effect';
import { defineDevstack, type Devstack, type DevstackConfig, type StackMember } from '../engine/supervisor.js';
import { manifest, type ManifestOptions } from '../primitives/manifest.js';
import { fillDefaults } from './defaults.js';

/** A single ref or an array of refs (from composite factories). The
 *  variadic `devstack(...args)` accepts both. */
export type DevstackRefInput = StackMember | ReadonlyArray<StackMember>;

/** Optional knobs accepted as the LAST argument to `devstack(...)`. */
export interface DevstackComposeOptions
	extends Omit<DevstackConfig, 'stack'> {
	/** Suppress the auto-included manifest sidecar. Useful for tests
	 *  that hand-roll their own manifest emission, or Effect-native
	 *  consumers that don't need the on-disk artifact. */
	readonly disableManifest?: boolean;
	/** Manifest extras: plain record, sync function, or Effect yielding a
	 *  record. Spliced into `.devstack/manifest.json`'s `extras` slot.
	 *  Use this when downstream consumers (dev wallet panels, frontend
	 *  app code) need on-disk values projected from `yield*`-able Refs
	 *  (`SealKeyServer`, an action's resolved `TxResult`, etc.). */
	readonly extras?:
		| Record<string, unknown>
		| (() => Record<string, unknown>)
		| Effect.Effect<Record<string, unknown>, unknown, unknown>;
}

const isOptions = (x: unknown): x is DevstackComposeOptions => {
	if (x === null || typeof x !== 'object') return false;
	// Refs (StackMembers) always carry a `__layer`. Options objects don't.
	return !('__layer' in (x as Record<string, unknown>));
};

/** Compose a devstack from typed Refs. Returns the same `Devstack`
 *  handle `defineDevstack(...)` returns (`run` / `runMain` / `layer`).
 *
 *  ```ts
 *  const alice = Account('alice');
 *  const hello = Package('hello', './move/hello', { signer: alice });
 *  export default devstack(alice, hello);
 *  ```
 *
 *  Variadic — pass any number of Refs (or arrays of Refs from composite
 *  factories like `Deepbook(...)`). The last argument may be an options
 *  object. */
export function devstack(...args: ReadonlyArray<DevstackRefInput | DevstackComposeOptions>): Devstack {
	// Split out the trailing options object (if any) from the leading refs.
	let opts: DevstackComposeOptions = {};
	const refArgs = [...args];
	const tail = refArgs[refArgs.length - 1];
	if (tail !== undefined && isOptions(tail)) {
		opts = tail as DevstackComposeOptions;
		refArgs.pop();
	}

	// Flatten ref + ref[] mix into a single StackMember[].
	const flat: Array<StackMember> = [];
	for (const arg of refArgs) {
		if (Array.isArray(arg)) {
			for (const r of arg) flat.push(r as StackMember);
		} else {
			flat.push(arg as StackMember);
		}
	}

	// Auto-include manifest unless suppressed. The v3 emitter is still in
	// place during Phase 2 — Phase 6 swaps this for emitManifestV4.
	const manifestOpts: ManifestOptions<'manifest', unknown, unknown> = {};
	if (opts.extras !== undefined) {
		(manifestOpts as { extras: typeof opts.extras }).extras = opts.extras;
	}
	const withManifest: ReadonlyArray<StackMember> = opts.disableManifest
		? flat
		: [...flat, manifest(manifestOpts) as unknown as StackMember];

	// Default-provider fill. Today this auto-adds `Sui()` when missing;
	// extends in Phase 6 with capability-keyed defaults.
	const filled = fillDefaults(withManifest);

	// Drop the compose-only knobs before forwarding so `defineDevstack`
	// doesn't see an unknown field.
	const { disableManifest: _drop, extras: _drop2, ...forwardedOpts } = opts;
	void _drop;
	void _drop2;

	return defineDevstack({ stack: filled, ...forwardedOpts });
}
