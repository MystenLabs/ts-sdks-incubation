// `devstack(...refs)` — the canonical entry. Variadic over Refs (and
// arrays of Refs from composite factories like `Deepbook(...)`),
// flattens to a single `StackMember[]`, runs the default-provider fill
// step, then delegates to `defineDevstack(...)`. Auto-includes the v4
// manifest emitter so the on-disk `.devstack/manifest.json` lands as a
// scoped side effect of acquiring the stack.

import { Effect, type Scope } from 'effect';
import {
	defineDevstack,
	type DevstackHandle,
	type DevstackConfig,
	type StackMember,
} from '../engine/supervisor.js';
import { tag } from '../advanced/tag.js';
import { emitManifestV4 } from '../runtime/manifest-emit.js';
import type { ExtrasInput, ExtrasResolved } from '../engine/extras.js';
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
import { defaultRendererResolver } from './renderer-factories.js';

/** A single ref or an array of refs (from composite factories). The
 *  variadic `devstack(...args)` accepts both. */
export type DevstackRefInput = StackMember | ReadonlyArray<StackMember>;

/** Optional knobs accepted as the LAST argument to `devstack(...)`. */
export interface DevstackComposeOptions extends Omit<DevstackConfig, 'stack'> {
	/** App extras: plain record, sync function, or Effect yielding a
	 *  record. Spliced into the manifest's `app.extras` slot AND
	 *  surfaced as the typed `extras` export from generated codegen
	 *  (`./generated/extras.ts`). Use this when downstream consumers
	 *  need values projected from `yield*`-able Refs (`SealKeyServerTag`,
	 *  an action's resolved `TxResult`, etc.). */
	readonly extras?: ExtrasInput;
}

const isOptions = (x: unknown): x is DevstackComposeOptions => {
	// Refs (StackMembers) always carry a `__layer` and arrive as plain
	// objects (never arrays — those are flattened composite Ref groups).
	return (
		typeof x === 'object' &&
		x !== null &&
		!('__layer' in (x as Record<string, unknown>)) &&
		!Array.isArray(x)
	);
};

/** Wrap the v4 manifest emitter in a `tag()` so it surfaces as a stack
 *  member with `__kind: 'app'`, gets a `manifest` row in the TUI, and
 *  rides the engine lifecycle. The body delegates to `emitManifestV4`
 *  which handles the file-write + tick-interval logic. */
const manifestRef = (): StackMember => {
	const body: Effect.Effect<
		Manifest,
		ManifestError,
		| PackageRegistry
		| EndpointRegistry
		| AccountRegistry
		| CoinRegistry
		| Identity
		| ExtrasResolved
		| Scope.Scope
	> = emitManifestV4();
	return tag('manifest', body, {
		kind: 'app',
		displayTitle: 'manifest',
	}) as unknown as StackMember;
};

/** Compose a devstack from typed Refs. Returns the same `DevstackHandle`
 *  `defineDevstack(...)` returns (`run` / `runMain` / `layer`).
 *
 *  ```ts
 *  const alice = Account('alice');
 *  const hello = Package('hello', './move/hello', { signer: alice });
 *  export default devstack(alice, hello);
 *  ```
 *
 *  Variadic — pass any number of Refs (or arrays of Refs from composite
 *  factories like `Deepbook(...)`). The last argument may be an options
 *  object.
 *
 *  **Plugin authors who need to compose Refs with explicit dependency
 *  wiring** (e.g. one Ref consuming another's output before the
 *  supervisor builds the Layer graph) can reach for `defineDevstack`
 *  from `@mysten-incubation/devstack/advanced`. That entry-point exposes
 *  the same handle shape but accepts a fully-built Layer instead of
 *  inferring it from the Refs — useful when you want to inject custom
 *  state-store keys or pre-compute a Ref's value at config-load time.
 *  Most consumers should NOT need it; `devstack(...)` covers the
 *  intended use case. */
export function devstack(
	...args: ReadonlyArray<DevstackRefInput | DevstackComposeOptions>
): DevstackHandle {
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
	// Skip the auto-append when the user already supplied a Faucet (any
	// `Faucet({...})`) — otherwise the empty auto-Faucet's layer would
	// shadow the user's via later-wins merge and silently drop their
	// custom strategies.
	const userSuppliedFaucet = flat.some((r) =>
		((r as { key?: string }).key ?? '').startsWith('faucet/'),
	);
	const withFaucet: ReadonlyArray<StackMember> = userSuppliedFaucet
		? flat
		: [...flat, Faucet() as unknown as StackMember];

	// Auto-include the v4 manifest emitter.
	const withManifest: ReadonlyArray<StackMember> = [...withFaucet, manifestRef()];

	// Default-provider fill. Auto-adds `Sui()` when missing; extends with
	// capability-keyed defaults.
	const filled = fillDefaults(withManifest);

	// Wire the default renderer resolver so the supervisor can map a
	// `RendererKind` (from `config.renderer` or the CLI `--renderer`
	// override) to a concrete factory without itself importing `tui/`.
	// User-supplied `rendererResolver` / `rendererFactory` still win
	// (later spread overrides the default).
	return defineDevstack({
		stack: filled,
		rendererResolver: defaultRendererResolver,
		...opts,
	});
}
