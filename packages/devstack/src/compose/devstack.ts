// `devstack(...refs)` — the canonical entry. Variadic over Refs (and
// arrays of Refs from composite factories like `Deepbook(...)`),
// flattens to a single `StackMember[]`, runs the default-provider fill
// step, then delegates to `defineDevstack(...)`. Auto-includes the v4
// manifest emitter so the on-disk `.devstack/manifest.json` lands as a
// scoped side effect of acquiring the stack.

import { Effect, type Scope } from 'effect';
import {
	defineDevstack,
	type Devstack,
	type DevstackConfig,
	type StackMember,
} from '../engine/supervisor.js';
import { tag } from '../advanced/tag.js';
import { emitManifestV4, type EmitManifestOptions } from '../runtime/manifest-emit.js';
import type { ManifestError } from '../engine/errors.js';
import {
	type AccountRegistry,
	type CoinRegistry,
	type EndpointRegistry,
	type PackageRegistry,
} from '../engine/registries.js';
import type { Identity } from '../engine/identity.js';
import type { Manifest } from '../runtime/manifest-schema.js';
import { Faucet } from '../faucet/factory.js';
import { fillDefaults } from './defaults.js';

/** A single ref or an array of refs (from composite factories). The
 *  variadic `devstack(...args)` accepts both. */
export type DevstackRefInput = StackMember | ReadonlyArray<StackMember>;

/** Optional knobs accepted as the LAST argument to `devstack(...)`. */
export interface DevstackComposeOptions extends Omit<DevstackConfig, 'stack'> {
	/** Manifest extras: plain record, sync function, or Effect yielding a
	 *  record. Spliced into `.devstack/manifest.json`'s `extras` slot.
	 *  Use this when downstream consumers (dev wallet panels, frontend
	 *  app code) need on-disk values projected from `yield*`-able Refs
	 *  (`SealKeyServer`, an action's resolved `TxResult`, etc.). */
	readonly extras?: EmitManifestOptions['extras'];
}

const isOptions = (x: unknown): x is DevstackComposeOptions => {
	if (x === null || typeof x !== 'object') return false;
	// Refs (StackMembers) always carry a `__layer`. Options objects don't.
	return !('__layer' in (x as Record<string, unknown>));
};

/** Wrap the v4 manifest emitter in a `tag()` so it surfaces as a stack
 *  member with `__kind: 'app'`, gets a `manifest` row in the TUI, and
 *  rides the engine lifecycle. The body delegates to `emitManifestV4`
 *  which handles the file-write + tick-interval logic. */
const manifestRef = (
	extras: DevstackComposeOptions['extras'],
): StackMember => {
	const body: Effect.Effect<
		Manifest,
		ManifestError,
		| PackageRegistry
		| EndpointRegistry
		| AccountRegistry
		| CoinRegistry
		| Identity
		| Scope.Scope
	> = emitManifestV4(extras !== undefined ? { extras } : {});
	return tag('manifest', body, {
		kind: 'app',
		displayTitle: 'manifest',
	}) as unknown as StackMember;
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
export function devstack(
	...args: ReadonlyArray<DevstackRefInput | DevstackComposeOptions>
): Devstack {
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

	// Auto-include the Faucet service so `Account({ funding })` always
	// finds a Faucet in scope. The Faucet ref's body best-effort yields
	// `SuiTag` to register the built-in SUI HTTP strategy; missing Sui
	// (rare — only in tests that override the default provider) leaves
	// the registry empty until the user registers their own strategies.
	const withFaucet: ReadonlyArray<StackMember> = [...flat, Faucet() as unknown as StackMember];

	// Auto-include the v4 manifest emitter.
	const withManifest: ReadonlyArray<StackMember> = [
		...withFaucet,
		manifestRef(opts.extras),
	];

	// Default-provider fill. Auto-adds `Sui()` when missing; extends with
	// capability-keyed defaults.
	const filled = fillDefaults(withManifest);

	// Drop the compose-only knobs before forwarding so `defineDevstack`
	// doesn't see an unknown field.
	const { extras: _drop, ...forwardedOpts } = opts;
	void _drop;

	return defineDevstack({ stack: filled, ...forwardedOpts });
}
