// CLI surface for devstack-effect.
//
// `devstack up [config-path]` is the primary entry — it dynamic-imports the
// user's `devstack.config.ts`, expects the default export to be a `Devstack`
// (from `defineDevstack`), and hands control to its `run()` method which
// blocks on Layer.launch until SIGINT/SIGTERM.
//
// `apply`, `status`, `snapshot`, `wipe`, `stack`, `doctor` are the v3-port
// reconcile / introspect / snapshot / teardown / multi-stack / preflight
// verbs — each lives in `./commands/<verb>.ts`. `manifest` and `version`
// are v1 stubs.
//
// Built on `effect/unstable/cli`. NOTE: this module is still unstable in v4
// beta — the surface (Argument/Flag/Command vs the older Args/Options names)
// is liable to shift before stabilization. Verify against
// `repos/effect-v4/packages/effect/src/unstable/cli/` if anything drifts.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Cause, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RendererKind, RunOverrides } from '../define-devstack.js';
import { prettyError } from '../internal/pretty-error.js';
import { applyCommand } from './commands/apply.js';
import { doctorCommand } from './commands/doctor.js';
import { snapshotCommand } from './commands/snapshot.js';
import { stackCommand } from './commands/stack.js';
import { statusCommand } from './commands/status.js';
import { wipeCommand } from './commands/wipe.js';

const VERSION = '0.0.0';

// `loadDevstack` and `up` previously wrapped failures with `new Error(\`...: ${String(cause)}\`)`,
// which flattens any structured cause (DockerError stderr/exitCode, SuiError
// phase, …) into a bare class-name + message. We instead keep the original
// cause intact in `Error.cause` and let the top-level `Cause`-aware reporter
// walk the full chain via `prettyError`.
const wrapCause = (prefix: string, cause: unknown): Error => {
	const err = new Error(`${prefix}: ${prettyError(cause).split('\n')[0]}`);
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
};

const loadDevstack = (configPath: string) =>
	Effect.gen(function* () {
		const absolute = resolvePath(process.cwd(), configPath);
		const url = pathToFileURL(absolute).href;
		const mod = yield* Effect.tryPromise({
			try: () => import(url) as Promise<{ default?: unknown }>,
			catch: (cause) => wrapCause(`failed to load ${configPath}`, cause),
		});
		const devstack = mod.default as
			| {
					run?: (overrides?: RunOverrides) => Promise<void>;
					launchEffect?: (overrides?: RunOverrides) => Effect.Effect<void, unknown, never>;
			  }
			| undefined;
		if (!devstack || typeof devstack.launchEffect !== 'function') {
			return yield* Effect.fail(
				new Error(`${configPath} must default-export a Devstack (from defineDevstack)`),
			);
		}
		return devstack as {
			launchEffect: (overrides?: RunOverrides) => Effect.Effect<void, unknown, never>;
		};
	});

const rendererFlag = Flag.choice('renderer', ['tui', 'plain', 'silent'] as const).pipe(
	Flag.optional,
	Flag.withDescription(
		'Status renderer: tui (in-terminal), plain (line-per-event to stderr), or silent. ' +
			'Defaults to tui on a TTY, plain otherwise.',
	),
);

const upCommand = Command.make(
	'up',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		renderer: rendererFlag,
	},
	({ configPath, renderer }) =>
		Effect.gen(function* () {
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadDevstack(resolved);
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

// v1 stub: prints the path the manifest would live at. Real implementation
// will read `.devstack/manifest.json` once the manifest primitive lands.
const manifestCommand = Command.make('manifest', {}, () =>
	Effect.sync(() => {
		const stateDir = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
		const path = resolvePath(process.cwd(), stateDir, 'manifest.json');
		// eslint-disable-next-line no-console
		console.log(`manifest stub — would read ${path}`);
	}),
).pipe(Command.withDescription('Print the current .devstack/manifest.json (stub)'));

const versionCommand = Command.make('version', {}, () =>
	Effect.sync(() => {
		// eslint-disable-next-line no-console
		console.log(VERSION);
	}),
).pipe(Command.withDescription('Print the devstack-effect package version'));

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
			const rendered = prettyError(cause);
			if (rendered.trim().length > 0) {
				// eslint-disable-next-line no-console
				console.error(rendered);
			}
		}),
	),
);
