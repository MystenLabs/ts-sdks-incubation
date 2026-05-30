// devstack CLI bin entry — argv → identity → deps → dispatch → exit.
//
// This file is the executable entry the `bin: { devstack: ... }`
// package.json field points at. Build output: `dist/cli/main.mjs`.
//
// Architecture invariant (surfaces/cli/index.ts header):
//   "`up` must hand its long-running effect to the outer Node runtime
//    directly, not nest a runtime — otherwise SIGINT cannot reach
//    scope finalizers and container teardown leaks."
//
// Shape:
//   1. Pre-parse identity inputs from argv + env (see
//      `identityInputsFromArgv`).
//   2. Resolve identity (app / stack / network / runtime root) via the
//      shared `api/inference-network` helpers.
//   3. Build the dispatcher's `CliDeps` bundle from each verb's wiring
//      module in `cli/wirings/`.
//   4. Hand control to the Stricli-backed dispatcher, which routes to
//      the verb-scoped wiring function.

import { realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { readProjectionSnapshot } from '../substrate/runtime/index.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import { dispatch, type CliDeps, CliUsageError } from '../surfaces/cli/index.ts';
import { emitFailure, nodeProcessIO } from '../surfaces/cli/output.ts';
import { ENV_VARS } from '../surfaces/cli/flags.ts';
import { defaultProbes } from './doctor-probes.ts';
import { nodeConfirmPrompt } from '../surfaces/cli/commands/confirm-node.ts';
import type { StatusReader } from '../surfaces/cli/commands/status.ts';
import { ExitCode } from '../surfaces/cli/sysexits.ts';
import { makeSnapshotReader } from './snapshot-reader.ts';
import {
	DevstackNetworkParseError,
	resolveAppName,
	resolveNetworkSync,
	resolveStackName,
	resolveStateDir,
} from '../api/inference-network.ts';
import { makeDirectPruneDeps } from './prune-direct.ts';
import { runUpLive } from './wirings/up.ts';
import { runApplyLive } from './wirings/apply.ts';
import {
	runSnapshotCaptureLiveAware,
	runSnapshotDeleteDirect,
	runSnapshotRestoreDirect,
} from './wirings/snapshot.ts';
import { runWipeDirect, runWipePlanDirect } from './wirings/wipe.ts';
import { makeConfigLoader, resolveConfigPath } from './wirings/config-loader.ts';
import type { ResolvedIdentity } from './wirings/identity.ts';

// -----------------------------------------------------------------------------
// Identity resolution
// -----------------------------------------------------------------------------

/** Resolve identity from flags + env. App and stack fall through the
 *  shared cwd/package metadata resolver before their defaults.
 *
 *  State-dir precedence ladder:
 *    `--state-dir` flag (`stateDir`) > `config.options.stateDir`
 *    (`configStateDir`) > `$DEVSTACK_STATE_DIR` > `<cwd>/.devstack`.
 *  The flag maps to `resolveStateDir`'s top `runtimeRoot` rung and the
 *  config value to its `stateDir` rung so the flag always wins over a
 *  config-declared `defineDevstack({ stateDir })`.
 *
 *  Stack-name precedence ladder (the SAME flag-beats-config shape as
 *  state-dir, so the two are consistent and reviewable side-by-side):
 *    `--stack` flag / `$DEVSTACK_STACK` (`params.stack`)
 *      > config's `defineDevstack({ stackName })`
 *      > cwd/package inference (default `'main'`).
 *  Config-vs-explicit resolution can't happen here (the config isn't
 *  loaded yet for the no-config verbs), so we record the explicit value
 *  on `ResolvedIdentity.explicitStack` and let the verb wirings apply
 *  `config.stackName` ONLY when no explicit stack was given — see
 *  `effectiveStackName` in `cli/wirings/identity.ts`. `params.stack` is
 *  exactly the explicit `--stack`-or-`$DEVSTACK_STACK` value (the argv
 *  pre-parser seeds it from env, then lets the flag overwrite it), and
 *  is `undefined` when neither was provided. */
const resolveIdentity = (params: {
	readonly app: string | undefined;
	readonly stack: string | undefined;
	readonly network: string | undefined;
	readonly stateDir: string | undefined;
	readonly configStateDir?: string | undefined;
	readonly cwd?: string;
}): ResolvedIdentity => {
	const cwd = params.cwd ?? process.cwd();
	const app = resolveAppName({
		explicit: params.app,
		cwd,
	});
	const runtimeRoot = resolveStateDir({
		runtimeRoot: params.stateDir,
		stateDir: params.configStateDir,
		env: process.env.DEVSTACK_STATE_DIR,
		cwd,
	});
	const stacksRoot = resolvePath(runtimeRoot, 'stacks');
	// `resolveStackName` here folds explicit (flag/env) > inferred >
	// default. Crucially it does NOT see `config.stackName`: a non-empty
	// `params.stack` means the operator was explicit, so `stack` already
	// equals the explicit value and `config.stackName` must not override
	// it downstream. An empty `params.stack` falls through to the
	// inferred/default name, which a verb's `config.stackName` may then
	// supersede via `effectiveStackName`.
	const explicitStack =
		params.stack !== undefined && params.stack.length > 0 ? params.stack : undefined;
	const stack = resolveStackName({
		explicit: params.stack,
		cwd,
	});
	// Centralized explicit > env > default ladder. Throws
	// `DevstackNetworkParseError` on a malformed value so the CLI fails
	// fast with a structured error instead of a downstream cryptic
	// chain-probe failure. The raw input is preserved (not the
	// canonical name) so chain-keyed cache namespaces stay stable.
	const network = resolveNetworkSync({
		explicit: params.network,
		env: process.env.DEVSTACK_NETWORK,
		explicitSource: '--network',
	}).raw;
	const stackRoot = resolvePath(stacksRoot, stack);
	return {
		app,
		stack,
		network,
		runtimeRoot,
		stacksRoot,
		stackRoot,
		rosterFile: resolvePath(stackRoot, 'roster.json'),
		explicitStack,
	};
};

// -----------------------------------------------------------------------------
// Verb deps composition
// -----------------------------------------------------------------------------

const projectionStatusReader = (identity: ResolvedIdentity): StatusReader => ({
	readState: () =>
		Effect.sync(() => readProjectionSnapshot(identity.stackRoot) as SubscribableState | null),
});

const buildDirectDeps = (identity: ResolvedIdentity): CliDeps => {
	return {
		up: {
			run: (flags) =>
				runUpLive(flags.configPath, identity, {
					renderer: flags.renderer,
					stdoutIsTty: Boolean((process.stdout as { isTTY?: boolean }).isTTY),
				}),
		},
		apply: {
			run: (flags) => runApplyLive(flags.configPath, identity),
		},
		status: { reader: projectionStatusReader(identity) },
		snapshot: {
			reader: makeSnapshotReader(identity),
			capture: (args) => runSnapshotCaptureLiveAware(identity, args),
			restore: (snapshotId) => runSnapshotRestoreDirect(identity, snapshotId),
			delete: (snapshotId) => runSnapshotDeleteDirect(identity, snapshotId),
			confirm: nodeConfirmPrompt,
		},
		prune: makeDirectPruneDeps({ runtimeRoot: identity.runtimeRoot }),
		doctor: {
			probes: defaultProbes({
				stateDir: identity.runtimeRoot,
				appRoot: identity.stacksRoot,
			}),
		},
		config: { loader: makeConfigLoader() },
		wipe: {
			wipe: () => runWipeDirect(identity),
			plan: () => runWipePlanDirect(identity),
			confirm: nodeConfirmPrompt,
		},
	};
};

// -----------------------------------------------------------------------------
// Argv pre-parser
// -----------------------------------------------------------------------------

/** @internal Exported for tests. Resolves identity flag inputs from a
 *  `--app <x>` / `--stack <x>` / `--network <x>` / `--state-dir <x>` /
 *  `--config <x>` argv, falling back to `DEVSTACK_*` env vars. Throws
 *  on a missing or flag-shaped value so a typo doesn't silently demote
 *  a downstream flag, and on a duplicate flag (`--app a --app b`) so
 *  the pre-parser does not silently last-write-wins a value that
 *  Stricli will later reject outright. */
export const identityInputsFromArgv = (
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>>,
) => {
	let app = env.DEVSTACK_APP;
	let stack = env.DEVSTACK_STACK;
	let network = env.DEVSTACK_NETWORK;
	// `stateDir` intentionally captures the `--state-dir` flag ONLY. The
	// full ladder — `--state-dir` flag > `config.options.stateDir`
	// (`defineDevstack({ stateDir })`) > `$DEVSTACK_STATE_DIR` >
	// `<cwd>/.devstack` — is assembled at the `resolveStateDir(...)`
	// call-site in `resolveIdentity`: the flag wins (top `runtimeRoot`
	// rung), the best-effort config value sits below it (`stateDir`
	// rung), then env, then the cwd default. Keeping the pre-parser a
	// thin flag-extractor means config + env precedence live in one place.
	let stateDir: string | undefined;
	let configPath = env.DEVSTACK_CONFIG;
	// Tracks which flags have been seen on the argv side so a second
	// occurrence trips a usage error before the value silently overwrites
	// the first. Env-sourced defaults are NOT counted (they are not user
	// argv).
	const seenArgvFlags = new Set<string>();
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		const readValue = (name: string): string | undefined => {
			let value: string | undefined;
			// `--name=value` form: trust the literal between `=` and end.
			if (token.startsWith(`--${name}=`)) {
				value = token.slice(name.length + 3);
			}
			// `--name value` form: peek the next token. Reject another
			// flag token (`--foo`) as the value — it almost certainly
			// means the user meant `--name <empty>` (typo / forgotten
			// argument) and quietly absorbing `--foo` as the value
			// silently demotes a downstream flag.
			else if (token === `--${name}`) {
				const next = argv[i + 1];
				if (next === undefined) {
					throw new CliUsageError({ message: `flag --${name} requires a value` });
				}
				if (next.startsWith('--')) {
					throw new CliUsageError({
						message: `flag --${name} requires a value; got "${next}" which looks like a flag`,
					});
				}
				value = next;
			}
			if (value === undefined) return undefined;
			if (seenArgvFlags.has(name)) {
				throw new CliUsageError({ message: `flag --${name} given more than once` });
			}
			seenArgvFlags.add(name);
			return value;
		};
		app = readValue('app') ?? app;
		stack = readValue('stack') ?? stack;
		network = readValue('network') ?? network;
		stateDir = readValue('state-dir') ?? stateDir;
		configPath = readValue('config') ?? configPath;
	}
	return { app, stack, network, stateDir, configPath };
};

const identityCwdFromConfig = (configPath: string | undefined): string => {
	const resolved = resolveConfigPath(configPath);
	return resolved === null ? process.cwd() : dirname(resolved);
};

/** Whether the resolved argv is a purely-informational invocation that
 *  never consumes `identity.runtimeRoot` (the only value the config
 *  pre-load feeds). For these we SKIP `configStateDirBestEffort` so we
 *  don't dynamic-import (and run the top-level side effects of) the
 *  user's `devstack.config.ts` — plus walk parent dirs — for commands
 *  the file header itself says must stay cheap:
 *
 *   - empty argv  → Stricli prints root help
 *   - `--help`/`-h` or `--version`/`-v` anywhere → Stricli short-circuits
 *   - first token `schema` → emits the static CLI schema (no state dir)
 *
 *  An unknown verb also never reaches a state-dir consumer (Stricli
 *  fails the parse), but we keep pre-loading on the general path: the
 *  pre-parser already accepted the identity flags, and gating on a
 *  closed verb set here would duplicate the dispatcher's route table.
 *  The two flagged-as-wasteful informational paths (help/version/schema)
 *  are the ones with a registered short-circuit, so skipping exactly
 *  those removes the eager-import surprise without re-deriving routes. */
const argvSkipsConfigPreload = (argv: ReadonlyArray<string>): boolean => {
	if (argv.length === 0) return true;
	for (const token of argv) {
		if (token === '--help' || token === '-h' || token === '--version' || token === '-v') {
			return true;
		}
	}
	const firstVerb = argv.find((token) => !token.startsWith('-'));
	return firstVerb === 'schema';
};

/** Best-effort read of `config.options.stateDir` (the value a program
 *  sets via `defineDevstack({ stateDir })`) for the state-dir precedence
 *  ladder in `resolveIdentity`. Swallows EVERY config-loader failure
 *  (not-found AND evaluation errors) and returns `undefined`:
 *
 *   - No-config verbs (`prune`, `wipe`) MUST keep resolving identity
 *     without a config, so a missing config silently falls through to
 *     the flag > env > cwd ladder.
 *   - A genuinely malformed config is NOT surfaced here — the verbs that
 *     actually consume config (`up` / `apply` via `makeConfigLoader`)
 *     re-load it and surface the typed `CliConfig*` error through the
 *     normal envelope path, so behavior for those verbs is unchanged.
 *
 *  This is one redundant config evaluation for `up` / `apply` (the verb
 *  wiring re-loads via its own loader); threading the loaded value into
 *  the verb dispatch would require touching the off-limits `wirings/up.ts`
 *  signature, so the duplicate import is accepted deliberately. */
const configStateDirBestEffort = async (
	configPath: string | undefined,
): Promise<string | undefined> => {
	const loaded = await Effect.runPromise(makeConfigLoader().load(configPath).pipe(Effect.option));
	if (loaded._tag === 'None') return undefined;
	const options = (loaded.value.stack as { readonly options?: { readonly stateDir?: string } })
		.options;
	const stateDir = options?.stateDir;
	return stateDir !== undefined && stateDir.length > 0 ? stateDir : undefined;
};

// -----------------------------------------------------------------------------
// Bin entry
// -----------------------------------------------------------------------------

export const runCli = async (
	argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> => {
	const stdinIsTty = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
	const env: Record<string, string | undefined> = { ...process.env };
	let identityInputs: ReturnType<typeof identityInputsFromArgv>;
	try {
		identityInputs = identityInputsFromArgv(argv, env);
	} catch (cause) {
		const error =
			cause instanceof CliUsageError
				? cause
				: new CliUsageError({
						message: cause instanceof Error ? cause.message : String(cause),
					});
		const jsonMode = env[ENV_VARS.JSON] === '1' || argv.includes('--json');
		await Effect.runPromise(
			emitFailure(nodeProcessIO, jsonMode ? 'json' : 'human', {
				command: '(parse-argv)',
				elapsedMs: 0,
				error,
			}),
		);
		return;
	}
	// Best-effort config pre-load for the state-dir ladder. Swallows
	// not-found / malformed configs so no-config verbs (prune/wipe) keep
	// working; the `--state-dir` flag still wins over the config value.
	// Skipped for informational invocations (help/version/schema/empty)
	// that never read `identity.runtimeRoot`, so those commands don't
	// dynamic-import the user's config (and run its top-level side
	// effects) just to print help.
	const configStateDir = argvSkipsConfigPreload(argv)
		? undefined
		: await configStateDirBestEffort(identityInputs.configPath);
	let identity: ResolvedIdentity;
	try {
		identity = resolveIdentity({
			app: identityInputs.app,
			stack: identityInputs.stack,
			network: identityInputs.network,
			stateDir: identityInputs.stateDir,
			configStateDir,
			cwd: identityCwdFromConfig(identityInputs.configPath),
		});
	} catch (cause) {
		// `resolveIdentity` -> `resolveNetworkSync` throws
		// `DevstackNetworkParseError` (a plain Error, NOT a CliError) on a
		// malformed `--network`/`$DEVSTACK_NETWORK` value. This runs OUTSIDE
		// the argv pre-parse try/catch above and BEFORE dispatch, so without
		// this guard the throw escapes to the bin entry's generic `.catch`
		// (exit 1, no envelope). Convert to `CliUsageError` and route through
		// the same envelope path the parse-argv block uses so a bad value
		// exits USAGE (64) with a JSON envelope in `--json` mode — never the
		// disallowed generic exit 1.
		const error =
			cause instanceof DevstackNetworkParseError
				? new CliUsageError({ message: cause.message })
				: cause instanceof CliUsageError
					? cause
					: new CliUsageError({
							message: cause instanceof Error ? cause.message : String(cause),
						});
		const jsonMode = env[ENV_VARS.JSON] === '1' || argv.includes('--json');
		await Effect.runPromise(
			emitFailure(nodeProcessIO, jsonMode ? 'json' : 'human', {
				command: '(resolve-identity)',
				elapsedMs: 0,
				error,
			}),
		);
		return;
	}
	const deps = buildDirectDeps(identity);
	await Effect.runPromise(
		dispatch(deps, {
			argv,
			env: {
				...env,
				DEVSTACK_APP: identity.app,
				DEVSTACK_STACK: identity.stack,
				DEVSTACK_STATE_DIR: identity.runtimeRoot,
			},
			stdinIsTty,
		}),
	);
};

const isMainEntrypoint = (): boolean => {
	const argvPath = process.argv[1];
	if (argvPath === undefined) return false;
	try {
		return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return import.meta.url === pathToFileURL(argvPath).href;
	}
};

if (isMainEntrypoint()) {
	// Intentionally do NOT call `process.exit(...)` after `runCli`:
	// `process.exit` synchronously terminates the event loop before any
	// pending `setImmediate` work flushes. The `up` lifecycle's hard-kill
	// path schedules its escalation via `setImmediate(process.exit)` in
	// `up-lifecycle.ts:scheduleProcessExit` (the file-header invariant for
	// SIGINT → finalizers requires the outer Node fiber to drain
	// naturally). Letting Node's natural exit handle the shutdown
	// preserves that invariant. We only set `process.exitCode` so the
	// final OS exit code reflects the verb's outcome.
	runCli().catch((err) => {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = ExitCode.GENERIC;
	});
}
