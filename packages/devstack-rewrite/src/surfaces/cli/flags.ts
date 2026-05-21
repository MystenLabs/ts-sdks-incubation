// CLI surface — shared flag parsing.
//
// Architecture (distilled/20-cli.md § Opportunities noticed): "One
// shared `--json` / `--dry-run` / `--yes` / `--stack` / `--app` flag
// definition consumed by every verb instead of duplicated
// declarations." This module is the single source of truth.
//
// Design: hand-rolled, not commander/yargs. Reasons:
//   - The verb set is small and fixed (architecture-enumerated).
//   - We need exact control over the envelope output mode, which
//     requires inspecting argv BEFORE dispatching (so failure
//     envelopes also obey `--json`).
//   - Avoid `effect/unstable/cli` for now — `unstable` semantics
//     don't suit the public CLI contract we ship.
//
// The parser is intentionally simple: GNU-style long flags
// (`--name=value` or `--name value`), boolean flags (`--name` /
// `--no-name`), short aliases declared per-flag, positional
// arguments collected in order. No clustering of short flags.

import { CliUsageError } from './errors.ts';

// -----------------------------------------------------------------------------
// Global flag definitions (shared across every verb)
// -----------------------------------------------------------------------------

/** Output mode resolved from `--json` (or `DEVSTACK_JSON=1`). */
export type OutputMode = 'human' | 'json';

/** Renderer selected by the CLI. `tui` maps to the Ink-backed live
 * dashboard; `plain` is line-oriented stderr output; `silent` mounts no
 * visible renderer. */
export type CliRendererMode = 'tui' | 'plain' | 'silent';

/** Confirmation policy resolved from `--yes` + `--no-input` + TTY
 *  state of stdin. */
export interface ConfirmPolicy {
	readonly assumeYes: boolean;
	readonly forbidPrompt: boolean;
	readonly stdinIsTty: boolean;
}

/** Bundle of flags every verb knows how to consume. Resolution
 *  precedence — applied in `parseGlobalFlags`:
 *
 *    explicit flag > env var > built-in default
 *
 *  Architecture invariant: stack-name resolution is `--stack >
 *  DEVSTACK_STACK > active-stack file > built-in default`. The
 *  active-stack-file lookup happens in the dispatcher (it needs IO),
 *  not here — `stack` may be `undefined` after parsing and is
 *  filled in later. */
export interface GlobalFlags {
	readonly outputMode: OutputMode;
	readonly app: string | undefined;
	readonly stack: string | undefined;
	readonly stateDir: string | undefined;
	readonly configPath: string | undefined;
	readonly network: string | undefined;
	readonly renderer: CliRendererMode | undefined;
	readonly dryRun: boolean;
	readonly confirm: ConfirmPolicy;
	/** `--schema --json` — emit the command tree as JSON and exit. */
	readonly schemaEmit: boolean;
	/** Verbosity bump; primarily affects logger filter. */
	readonly verbose: boolean;
	/** Print help instead of running. */
	readonly help: boolean;
	/** Print version one-liner and exit. */
	readonly version: boolean;
	/** Argv tail after the global-flag pass; subcommand parsers slice
	 *  positional arguments and verb-specific flags out of this. */
	readonly rest: ReadonlyArray<string>;
}

/** Environment-variable names the CLI consults. Centralized so the
 *  `--schema --json` action can enumerate them. */
export const ENV_VARS = {
	JSON: 'DEVSTACK_JSON',
	NO_INPUT: 'DEVSTACK_NO_INPUT',
	APP: 'DEVSTACK_APP',
	STACK: 'DEVSTACK_STACK',
	STATE_DIR: 'DEVSTACK_STATE_DIR',
	CONFIG_PATH: 'DEVSTACK_CONFIG',
	NETWORK: 'DEVSTACK_NETWORK',
	RENDERER: 'DEVSTACK_RENDERER',
	NO_COLOR: 'NO_COLOR',
} as const;

export type EnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

interface ParseEnv {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdinIsTty: boolean;
}

const parseRendererMode = (value: string, source: string): CliRendererMode => {
	switch (value) {
		case 'tui':
		case 'plain':
		case 'silent':
			return value;
		default:
			throw new CliUsageError({
				message: `${source} must be one of: tui, plain, silent`,
			});
	}
};

/** Parse argv into a `GlobalFlags` bundle and a rest tail. Throws
 *  `CliUsageError` on malformed input. Does not consult IO beyond
 *  `env` + `stdinIsTty` (both injected so tests can drive it). */
export const parseGlobalFlags = (argv: ReadonlyArray<string>, parseEnv: ParseEnv): GlobalFlags => {
	const { env, stdinIsTty } = parseEnv;

	let outputMode: OutputMode = env[ENV_VARS.JSON] === '1' ? 'json' : 'human';
	let app: string | undefined = env[ENV_VARS.APP];
	let stack: string | undefined = env[ENV_VARS.STACK];
	let stateDir: string | undefined = env[ENV_VARS.STATE_DIR];
	let configPath: string | undefined = env[ENV_VARS.CONFIG_PATH];
	let network: string | undefined = env[ENV_VARS.NETWORK];
	const envRenderer = env[ENV_VARS.RENDERER];
	let renderer =
		envRenderer === undefined ? undefined : parseRendererMode(envRenderer, ENV_VARS.RENDERER);
	let dryRun = false;
	let assumeYes = false;
	let forbidPrompt = env[ENV_VARS.NO_INPUT] === '1';
	let schemaEmit = false;
	let verbose = false;
	let help = false;
	let version = false;
	const rest: Array<string> = [];

	// Walk argv. We only consume long-flag global tokens; everything
	// else flows through to `rest` for the subcommand parser. A `--`
	// terminator ends global parsing and forwards everything verbatim.
	let i = 0;
	while (i < argv.length) {
		const tok = argv[i]!;
		if (tok === '--') {
			for (let j = i + 1; j < argv.length; j++) rest.push(argv[j]!);
			break;
		}
		if (!tok.startsWith('-')) {
			rest.push(tok);
			i += 1;
			continue;
		}

		// Long flag: `--foo` or `--foo=bar` or `--no-foo`.
		const eqIdx = tok.indexOf('=');
		const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
		const inlineValue = eqIdx >= 0 ? tok.slice(eqIdx + 1) : undefined;

		// Helper to pop the next argv token as a value, or read the
		// inline value. Throws if absent.
		const popValue = (flagName: string): string => {
			if (inlineValue !== undefined) return inlineValue;
			const nxt = argv[i + 1];
			if (nxt === undefined || nxt.startsWith('-')) {
				throw new CliUsageError({
					message: `flag --${flagName} requires a value`,
				});
			}
			i += 1;
			return nxt;
		};

		switch (name) {
			case 'json':
				outputMode = 'json';
				break;
			case 'app':
				app = popValue('app');
				break;
			case 'stack':
				stack = popValue('stack');
				break;
			case 'state-dir':
				stateDir = popValue('state-dir');
				break;
			case 'config':
				configPath = popValue('config');
				break;
			case 'network':
				network = popValue('network');
				break;
			case 'renderer':
				renderer = parseRendererMode(popValue('renderer'), '--renderer');
				break;
			case 'dry-run':
				dryRun = true;
				break;
			case 'yes':
				assumeYes = true;
				break;
			case 'no-input':
				forbidPrompt = true;
				break;
			case 'schema':
				schemaEmit = true;
				break;
			case 'verbose':
				verbose = true;
				break;
			case 'help':
				help = true;
				break;
			case 'version':
				version = true;
				break;
			default:
				// Unknown global flag — leave for the subcommand parser
				// (it may know what to do with `--include-images` etc.).
				rest.push(tok);
				break;
		}
		i += 1;
	}

	// Mutually-exclusive flag check: `--yes` + `--no-input` with a
	// prompt-needing verb is the documented usage error in the
	// architecture; the dispatcher decides per-verb whether to enforce.
	// We surface the raw state here.

	return {
		outputMode,
		app,
		stack,
		stateDir,
		configPath,
		network,
		renderer,
		dryRun,
		confirm: { assumeYes, forbidPrompt, stdinIsTty },
		schemaEmit,
		verbose,
		help,
		version,
		rest,
	};
};

// -----------------------------------------------------------------------------
// Subcommand-flag helpers
// -----------------------------------------------------------------------------

/** Pop the next positional argument from `rest`. Returns undefined if
 *  none remain. */
export const takePositional = (
	rest: ReadonlyArray<string>,
): { readonly head: string | undefined; readonly tail: ReadonlyArray<string> } => {
	const idx = rest.findIndex((tok) => !tok.startsWith('-'));
	if (idx === -1) return { head: undefined, tail: rest };
	const tail = [...rest.slice(0, idx), ...rest.slice(idx + 1)];
	return { head: rest[idx], tail };
};

/** Look up a boolean flag in `rest` by name (long form only). Returns
 *  the matched flag plus the remaining tokens. */
export const takeBoolFlag = (
	rest: ReadonlyArray<string>,
	name: string,
): { readonly present: boolean; readonly tail: ReadonlyArray<string> } => {
	const flag = `--${name}`;
	const idx = rest.indexOf(flag);
	if (idx === -1) return { present: false, tail: rest };
	const tail = [...rest.slice(0, idx), ...rest.slice(idx + 1)];
	return { present: true, tail };
};

/** Look up a value flag (`--name=val` or `--name val`). */
export const takeValueFlag = (
	rest: ReadonlyArray<string>,
	name: string,
): { readonly value: string | undefined; readonly tail: ReadonlyArray<string> } => {
	const prefix = `--${name}=`;
	for (let i = 0; i < rest.length; i++) {
		const tok = rest[i]!;
		if (tok.startsWith(prefix)) {
			return {
				value: tok.slice(prefix.length),
				tail: [...rest.slice(0, i), ...rest.slice(i + 1)],
			};
		}
		if (tok === `--${name}`) {
			const next = rest[i + 1];
			if (next === undefined || next.startsWith('-')) {
				throw new CliUsageError({ message: `flag --${name} requires a value` });
			}
			return {
				value: next,
				tail: [...rest.slice(0, i), ...rest.slice(i + 2)],
			};
		}
	}
	return { value: undefined, tail: rest };
};
