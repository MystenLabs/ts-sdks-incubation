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
import {
	dispatch,
	type CliDeps,
	CliUsageError,
} from '../surfaces/cli/index.ts';
import { emitFailure, nodeProcessIO } from '../surfaces/cli/output.ts';
import { ENV_VARS } from '../surfaces/cli/flags.ts';
import { defaultProbes } from './doctor-probes.ts';
import { nodeConfirmPrompt } from '../surfaces/cli/commands/confirm-node.ts';
import type { StatusReader } from '../surfaces/cli/commands/status.ts';
import { ExitCode } from '../surfaces/cli/sysexits.ts';
import { makeSnapshotReader } from './snapshot-reader.ts';
import {
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
import { runWipeDirect } from './wirings/wipe.ts';
import { makeConfigLoader, resolveConfigPath } from './wirings/config-loader.ts';
import type { ResolvedIdentity } from './wirings/identity.ts';

// -----------------------------------------------------------------------------
// Identity resolution
// -----------------------------------------------------------------------------

/** Resolve identity from flags + env. App and stack fall through the
 *  shared cwd/package metadata resolver before their defaults. */
const resolveIdentity = (params: {
	readonly app: string | undefined;
	readonly stack: string | undefined;
	readonly network: string | undefined;
	readonly stateDir: string | undefined;
	readonly cwd?: string;
}): ResolvedIdentity => {
	const cwd = params.cwd ?? process.cwd();
	const app = resolveAppName({
		explicit: params.app,
		cwd,
	});
	const runtimeRoot = resolveStateDir({
		stateDir: params.stateDir,
		env: process.env.DEVSTACK_STATE_DIR,
		cwd,
	});
	const stacksRoot = resolvePath(runtimeRoot, 'stacks');
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
	};
};

// -----------------------------------------------------------------------------
// Verb deps composition
// -----------------------------------------------------------------------------

const projectionStatusReader = (identity: ResolvedIdentity): StatusReader => ({
	readState: (_app, _stack) =>
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
	// `stateDir` intentionally captures the `--state-dir` flag ONLY.
	// Env (`DEVSTACK_STATE_DIR`) precedence is applied at the
	// `resolveStateDir(...)` call-site in `resolveIdentity` so the
	// pre-parser stays a thin flag-extractor.
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
	const identity = resolveIdentity({
		app: identityInputs.app,
		stack: identityInputs.stack,
		network: identityInputs.network,
		stateDir: identityInputs.stateDir,
		cwd: identityCwdFromConfig(identityInputs.configPath),
	});
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
