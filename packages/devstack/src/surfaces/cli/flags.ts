// CLI surface — shared flag types and subcommand helpers.
//
// Stricli owns argv parsing in `surfaces/cli/index.ts`. This file
// keeps the resolved flag shape and the tiny helpers used by nested
// command implementations that still receive a typed `rest` tail
// (currently snapshot subcommands).

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

/** Bundle of command-scoped flags after Stricli parsing plus env
 *  fallback resolution. */
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
	/** Verbosity bump; primarily affects logger filter. */
	readonly verbose: boolean;
	/** Argv tail after the global-flag pass; subcommand parsers slice
	 *  positional arguments and verb-specific flags out of this. */
	readonly rest: ReadonlyArray<string>;
}

/** Environment-variable names the CLI consults. Centralized so the
 *  `schema --json` command can enumerate them. */
export const ENV_VARS = {
	JSON: 'DEVSTACK_JSON',
	NO_INPUT: 'DEVSTACK_NO_INPUT',
	APP: 'DEVSTACK_APP',
	STACK: 'DEVSTACK_STACK',
	STATE_DIR: 'DEVSTACK_STATE_DIR',
	CONFIG_PATH: 'DEVSTACK_CONFIG',
	NETWORK: 'DEVSTACK_NETWORK',
	NO_COLOR: 'NO_COLOR',
} as const;

export type EnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];

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
