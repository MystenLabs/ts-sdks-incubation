// Shared flag definitions for the CLI. Hoisted so multiple commands
// (`up`, `apply`, future `verify`) reuse one source of truth instead
// of redefining `--renderer` / `--network` per command and risking
// drift in their description strings or choice sets.

import { Option } from 'effect';
import { Flag } from 'effect/unstable/cli';

/** `--renderer` for commands that drive the supervisor. Optional —
 *  the engine defaults to `tui` on a TTY and `plain` otherwise. */
export const rendererFlag = Flag.choice('renderer', ['tui', 'plain', 'silent'] as const).pipe(
	Flag.optional,
	Flag.withDescription(
		'Status renderer: tui (in-terminal), plain (line-per-event to stderr), or silent. ' +
			'Defaults to tui on a TTY, plain otherwise.',
	),
);

/** `--network` for any command that loads a `devstack.config.ts`. The
 *  flag value must reach `process.env.DEVSTACK_NETWORK` BEFORE the
 *  config's `import(...)` so every network-aware factory (Sui, Seal,
 *  Walrus, Deepbook) sees it at construction time. */
export const networkFlag = Flag.choice('network', ['localnet', 'testnet', 'mainnet'] as const).pipe(
	Flag.optional,
	Flag.withDescription(
		'Target Sui network. Sets DEVSTACK_NETWORK before loading the config so every ' +
			'factory (Sui, Seal, Walrus, Deepbook) sees the same value. Defaults to localnet.',
	),
);

/** Mutate `process.env.DEVSTACK_NETWORK` from a `--network` flag value.
 *  No-op when `Option.none`. Call BEFORE the dynamic-import that loads
 *  the user's config — every network-aware factory reads the env var
 *  at construction time. */
export const applyNetworkOverride = (
	network: Option.Option<'localnet' | 'testnet' | 'mainnet'>,
): void => {
	Option.match(network, {
		onNone: () => undefined,
		onSome: (n) => {
			process.env.DEVSTACK_NETWORK = n;
			return undefined;
		},
	});
};
