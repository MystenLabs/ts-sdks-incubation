// `devstack(...refs)` — the canonical entry. Variadic over Refs (and
// arrays of Refs from composite factories like `Deepbook(...)`),
// flattens to a single `StackMember[]`, runs the default-provider fill
// step, then delegates to `defineDevstack(...)`. Auto-includes the
// manifest emitter so the on-disk `.devstack/manifest.json` lands as a
// scoped side effect of acquiring the stack.

import { Effect, Layer, Ref, type Scope } from 'effect';
import {
	defineDevstack,
	type DevstackHandle,
	type DevstackConfig,
	type StackMember,
} from '../engine/supervisor.js';
import { DevstackTagBrand, tag } from '../advanced/tag.js';
import { emitManifest } from '../runtime/manifest-emit.js';
import type { ExtrasInput, ExtrasResolved } from '../engine/extras.js';
import type { ManifestError } from '../engine/errors.js';
import type { EngineHandleShape } from '../engine/engine.js';
import {
	type AccountRegistry,
	type CoinRegistry,
	type DeepbookStateRegistry,
	type EndpointRegistry,
	type PackageRegistry,
	type SealStateRegistry,
	type SuiStateRegistry,
	type WalrusStateRegistry,
} from '../engine/registries.js';
import type {
	RendererFactory,
	RendererKind,
	RendererMount,
	RendererMountDeps,
	RendererResolver,
} from '../engine/renderer.js';
import { silentRendererFactory } from '../engine/renderer.js';
import type { Identity } from '../engine/identity.js';
import type { Manifest } from '../runtime/manifest-schema.js';
import { startPlainRenderer } from '../tui/plain.js';
import { startTuiOnce, TuiLoggerLayer } from '../tui/index.js';
import { fillDefaults } from './defaults.js';

// Concrete renderer factories — bridge between `engine/renderer.ts`'s
// abstract `RendererFactory` contract and the concrete TUI / plain
// renderers in `tui/`. Lives here (not in `engine/`) so the supervisor
// itself stays out of the upward import chain into `tui/`.

/** TUI factory — mounts ink ONCE for the supervisor lifetime via
 *  `startTuiOnce()`, then redirects the cycle engine into the (stable)
 *  proxy on every `install()`. Logger layer routes `Effect.log*` into
 *  the engine's bounded log buffer so log output stays serialised with
 *  the dashboard frames. */
const tuiRendererFactory: RendererFactory = {
	kind: 'tui',
	mount: (_deps: RendererMountDeps) =>
		Effect.gen(function* () {
			const mount = yield* startTuiOnce();
			return {
				install: mount.install,
				flush: mount.flush,
			} satisfies RendererMount;
		}),
	loggerLayer: (engine: EngineHandleShape) => TuiLoggerLayer(engine),
};

/** Plain renderer factory — starts the line-per-event diff loop ONCE
 *  on the supervisor's outer scope; the cycle engine is read directly
 *  from `tuiStateRef` so `install()` is a no-op. The default Effect
 *  logger continues to write through Logger's default sink (plain text
 *  on stderr) — no engine-buffer redirection. */
const plainRendererFactory: RendererFactory = {
	kind: 'plain',
	mount: (deps: RendererMountDeps) =>
		Effect.gen(function* () {
			const handle = yield* startPlainRenderer(Ref.get(deps.tuiStateRef));
			return {
				install: () => Effect.void,
				flush: handle.flush as Effect.Effect<void>,
			} satisfies RendererMount;
		}),
	// Route `Effect.log*` calls through `engine.appendLog` (same
	// machinery the TUI uses), so plain-mode emits log lines through
	// `tui/plain.ts::formatLogLine` (`[HH:MM:SS] LEVEL message`) — in
	// step with the per-tag status lines — instead of letting Effect's
	// default `Logger.consoleLogger` interleave its
	// `[HH:MM:SS.mmm] INFO (#fiber): message` format on stderr.
	loggerLayer: (engine: EngineHandleShape) => TuiLoggerLayer(engine),
};

/** Default resolver — maps each `RendererKind` to the matching
 *  concrete factory. Wired into `defineDevstack` below so the
 *  supervisor doesn't need to import anything from `tui/`. */
const defaultRendererResolver: RendererResolver = (kind: RendererKind): RendererFactory => {
	if (kind === 'tui') return tuiRendererFactory;
	if (kind === 'plain') return plainRendererFactory;
	return silentRendererFactory;
};

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
	// Refs (StackMembers) always carry the `DevstackTagBrand` symbol and
	// arrive as plain objects (never arrays — those are flattened
	// composite Ref groups). The brand is a unique symbol stamped by
	// `provide` / `tag`, so this discriminates a Ref from a plain
	// options object without relying on a stringly-typed field.
	return (
		typeof x === 'object' &&
		x !== null &&
		!(DevstackTagBrand in (x as Record<symbol, unknown>)) &&
		!Array.isArray(x)
	);
};

/** Wrap the manifest emitter in a `tag()` so it surfaces as a stack
 *  member with `__kind: 'app'`, gets a `manifest` row in the TUI, and
 *  rides the engine lifecycle. The body delegates to `emitManifest`
 *  which handles the file-write + tick-interval logic. */
const manifestRef = (): StackMember => {
	const body: Effect.Effect<
		Manifest,
		ManifestError,
		| PackageRegistry
		| EndpointRegistry
		| AccountRegistry
		| CoinRegistry
		| SuiStateRegistry
		| SealStateRegistry
		| WalrusStateRegistry
		| DeepbookStateRegistry
		| Identity
		| ExtrasResolved
		| Scope.Scope
	> = emitManifest();
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

	// Auto-include the manifest emitter. `Sui()` + `Faucet()`
	// defaults land via `fillDefaults` below.
	const withManifest: ReadonlyArray<StackMember> = [...flat, manifestRef()];

	// Default-provider fill — auto-adds `Sui()` and `Faucet()` when
	// missing.
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
