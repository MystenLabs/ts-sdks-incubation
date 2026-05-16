// CLI surface for devstack.
//
// `devstack up [config-path]` is the primary entry — it dynamic-imports the
// user's `devstack.config.ts`, expects the default export to be a
// `DevstackHandle` (from `defineDevstack`), and hands control to its `run()` method which
// blocks on Layer.launch until SIGINT/SIGTERM.
//
// `apply`, `status`, `snapshot`, `wipe`, `stack`, `doctor`, `manifest` are
// the v3-port reconcile / introspect / snapshot / teardown / multi-stack /
// preflight / manifest-dump verbs — each lives in `./commands/<verb>.ts`.
// `version` is defined inline (one-liner).
//
// Built on `effect/unstable/cli`. NOTE: this module is still unstable in v4
// beta — the surface (Argument/Flag/Command vs the older Args/Options names)
// is liable to shift before stabilization. Verify against
// `repos/effect-v4/packages/effect/src/unstable/cli/` if anything drifts.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Cause, Effect, Option } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import type { RendererKind, RunOverrides } from '../engine/supervisor.js';
import { prettyError } from '../engine/pretty-error.js';
import { causeHasAlreadyReported } from './already-reported.js';
import { applyNetworkOverride, networkFlag, rendererFlag } from './flags.js';
import { loadConfigModule, requireLaunchEffect } from './loaders.js';
import { applyCommand } from './commands/apply.js';
import { doctorCommand } from './commands/doctor.js';
import { manifestCommand } from './commands/manifest.js';
import { pruneCommand } from './commands/prune.js';
import { snapshotCommand } from './commands/snapshot.js';
import { stackCommand } from './commands/stack.js';
import { statusCommand } from './commands/status.js';
import { wipeCommand } from './commands/wipe.js';
import packageJson from '../../package.json' with { type: 'json' };

const VERSION = packageJson.version;

const upCommand = Command.make(
	'up',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		renderer: rendererFlag,
		network: networkFlag,
	},
	({ configPath, renderer, network }) =>
		Effect.gen(function* () {
			applyNetworkOverride(network);
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadConfigModule(resolved, requireLaunchEffect);
			const overrides: RunOverrides = Option.match(renderer, {
				onNone: () => ({}),
				onSome: (kind: RendererKind) => ({ renderer: kind }),
			});
			// yield* the launch effect natively so the outer NodeRuntime's
			// SIGINT handler propagates interruption into the scope teardown
			// — finalizers (docker rm -f, etc.) need to run before exit.
			// Nesting `Effect.runPromise` (the old `devstack.run` path)
			// creates a sibling runtime whose fibers SIGINT can't reach.
			yield* devstack.launchEffect(overrides) as Effect.Effect<void, unknown, never>;
		}),
).pipe(Command.withDescription('Boot the devstack defined by the given config file'));

const versionCommand = Command.make('version', {}, () =>
	Effect.sync(() => {
		// eslint-disable-next-line no-console
		console.log(VERSION);
	}),
).pipe(Command.withDescription('Print the devstack package version'));

/**
 * Composed root command tree. Exported so smoke tests can walk the
 * subcommand list and assert the CLI surface against a fixed expectation.
 */
export const rootCommand = Command.make('devstack').pipe(
	Command.withDescription('Effect-based devstack: compose dev infra from your config'),
	Command.withSubcommands([
		upCommand,
		applyCommand,
		statusCommand,
		snapshotCommand,
		wipeCommand,
		pruneCommand,
		stackCommand,
		doctorCommand,
		manifestCommand,
		versionCommand,
	]),
);

/**
 * The composed CLI effect. Reads args from the `Stdio` service (NodeStdio
 * slices `process.argv` automatically), parses, and dispatches. Caller is
 * responsible for providing the Node platform layers (see `./main.ts`).
 *
 * `Effect.tapCause` runs BEFORE `NodeRuntime.runMain`'s default reporter so the
 * user sees the full tagged-error tree (DockerError stderr / SuiError phase /
 * … nested by `cause`) instead of just the outermost class name that
 * `runMain`'s built-in reporter prints. Errors still flow through to
 * `runMain` so it can set the process exit code; we just augment its output.
 */
export const cli = Command.run(rootCommand, { version: VERSION }).pipe(
	Effect.tapCause((cause: Cause.Cause<unknown>) =>
		Effect.sync(() => {
			// Subcommands that already printed a human-readable error
			// (e.g. `apply` writing `apply failed: …` itself) tag their
			// final `Effect.fail` with `AlreadyReportedError`. Skip our
			// own pretty-print so the user sees one error, not two.
			if (causeHasAlreadyReported(cause)) return;
			const rendered = prettyError(cause);
			if (rendered.trim().length > 0) {
				// eslint-disable-next-line no-console
				console.error(rendered);
			}
		}),
	),
);
