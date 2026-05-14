// provideDevstack — pure-DI variant of `defineDevstack`.
//
// `defineDevstack` is a *runner*: it composes the user's stack into a
// Layer, then wraps it in a launch loop that attaches a TUI / plain
// renderer, file watchers, signal handlers, and a restart Deferred.
// That's the right shape for the `devstack up` CLI use case.
//
// `provideDevstack` is the same composition step WITHOUT the launch
// loop. The returned Layer goes straight to `Effect.provide` in a
// caller-owned program — typically `NodeRuntime.runMain(program.pipe(
// Effect.provide(layer)))`. No TUI, no signal handlers, no run loop.
//
// This is the API consumers reach for when:
//
//   - They have an Effect program already and want to plug in Devstack
//     services (e.g. `Sui`, `Walrus`, etc.) for testing, scripts, or
//     embedding inside a larger application.
//   - They want to swap localnet for testnet/mainnet in a single line
//     (e.g. `provideDevstack([suiLocalnet()])` in dev,
//     `provideDevstack([suiTestnet()])` in prod) without touching the
//     program above.
//
// The layer's R channel is `never` (Platform layers are merged in) and
// its ROut / E channels are intentionally open: every primitive
// contributes its own service / error vocabulary, so we can't usefully
// narrow without forcing the caller to thread a giant union through
// every program. Consumers `yield* Sui` (etc.) from inside their
// Effect.gen and the Context resolves at runtime.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Layer } from 'effect';
import {
	composeStackLayer,
	type StackMember,
	type StackComposeOptions,
} from './define-devstack.js';
import type { SuiNetwork } from './primitives/sui.js';

export interface ProvideDevstackOptions {
	/**
	 * Logical stack name — partitions persisted state under
	 * `.devstack/stacks/<stack>/` on localnet so multiple workers (vitest,
	 * playwright, parallel devs) can coexist. Ignored on live nets.
	 * Defaults to `'main'`.
	 */
	readonly stackName?: string;
	/**
	 * Target Sui network. Drives state-file layout:
	 *   - `localnet` → `.devstack/stacks/<stackName>/state.json`
	 *   - other     → `.devstack/networks/<network>.json`
	 * Defaults to `'localnet'`.
	 */
	readonly network?: SuiNetwork;
	/** Override the state-store base directory. Rarely needed outside tests. */
	readonly stateDir?: string;
}

/**
 * Returns the fully-composed Devstack layer ready for `Effect.provide` in
 * any Effect application. Unlike `defineDevstack`, this does NOT attach a
 * TUI, plain renderer, file watcher, signal handlers, or run loop — it's
 * pure DI.
 *
 * Use this when you want to consume Devstack services from inside an
 * Effect program rather than running a CLI dev-stack.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect';
 * import { runMain } from '@effect/platform-node/NodeRuntime';
 * import { provideDevstack, suiLocalnet, Sui } from '@mysten-incubation/devstack-effect';
 *
 * const program = Effect.gen(function* () {
 *   const sui = yield* Sui;
 *   yield* Effect.log(`chain ${sui.chainId}`);
 * });
 *
 * runMain(program.pipe(Effect.provide(provideDevstack([suiLocalnet()]))));
 * ```
 */
export const provideDevstack = (
	stack: ReadonlyArray<StackMember>,
	opts: ProvideDevstackOptions = {},
): Layer.Layer<unknown, unknown, never> => {
	const composeOpts: StackComposeOptions = {
		stackName: opts.stackName,
		network: opts.network,
		stateDir: opts.stateDir,
	};
	return composeStackLayer(stack, composeOpts);
};
