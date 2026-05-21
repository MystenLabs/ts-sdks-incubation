// Argv → GlobalFlags parsing.
//
// Architecture invariants verified here:
//   - precedence: explicit flag > env > built-in default
//   - `--json` toggles output mode
//   - `--` terminator stops global parsing
//   - `--foo=value` and `--foo value` both accepted
//   - unknown flags pass through to subcommand parsers (rest)

import { describe, expect, it } from 'vitest';

import {
	ENV_VARS,
	parseGlobalFlags,
	takeBoolFlag,
	takePositional,
	takeValueFlag,
} from '../../../src/surfaces/cli/flags.ts';
import { CliUsageError } from '../../../src/surfaces/cli/errors.ts';

const emptyEnv = { env: {}, stdinIsTty: true } as const;

describe('parseGlobalFlags', () => {
	it('defaults output mode to human', () => {
		const f = parseGlobalFlags(['status'], emptyEnv);
		expect(f.outputMode).toBe('human');
		expect(f.rest).toEqual(['status']);
	});

	it('--json forces json mode', () => {
		const f = parseGlobalFlags(['--json', 'status'], emptyEnv);
		expect(f.outputMode).toBe('json');
	});

	it('DEVSTACK_JSON=1 forces json mode', () => {
		const f = parseGlobalFlags(['status'], {
			env: { [ENV_VARS.JSON]: '1' },
			stdinIsTty: false,
		});
		expect(f.outputMode).toBe('json');
	});

	it('--stack reads next token', () => {
		const f = parseGlobalFlags(['--stack', 'dev', 'up'], emptyEnv);
		expect(f.stack).toBe('dev');
		expect(f.rest).toEqual(['up']);
	});

	it('--stack=value reads inline', () => {
		const f = parseGlobalFlags(['--stack=dev', 'up'], emptyEnv);
		expect(f.stack).toBe('dev');
		expect(f.rest).toEqual(['up']);
	});

	it('flag > env precedence', () => {
		const f = parseGlobalFlags(['--stack', 'override', 'up'], {
			env: { [ENV_VARS.STACK]: 'envval' },
			stdinIsTty: true,
		});
		expect(f.stack).toBe('override');
	});

	it('env when no flag present', () => {
		const f = parseGlobalFlags(['up'], {
			env: { [ENV_VARS.STACK]: 'envval' },
			stdinIsTty: true,
		});
		expect(f.stack).toBe('envval');
	});

	it('-- terminator stops global parsing', () => {
		const f = parseGlobalFlags(['--json', '--', '--json', 'literal'], emptyEnv);
		expect(f.outputMode).toBe('json');
		expect(f.rest).toEqual(['--json', 'literal']);
	});

	it('unknown long flag passes through to rest', () => {
		const f = parseGlobalFlags(['--include-images', 'prune'], emptyEnv);
		expect(f.rest).toEqual(['--include-images', 'prune']);
	});

	it('throws on missing value', () => {
		expect(() => parseGlobalFlags(['--stack'], emptyEnv)).toThrow(CliUsageError);
	});

	it('--no-input + --yes both surface', () => {
		const f = parseGlobalFlags(['--no-input', '--yes', 'prune'], emptyEnv);
		expect(f.confirm.assumeYes).toBe(true);
		expect(f.confirm.forbidPrompt).toBe(true);
	});

	it('stdin TTY state propagates', () => {
		const f = parseGlobalFlags(['prune'], { env: {}, stdinIsTty: false });
		expect(f.confirm.stdinIsTty).toBe(false);
	});

	it('--dry-run sets the boolean', () => {
		const f = parseGlobalFlags(['--dry-run', 'prune'], emptyEnv);
		expect(f.dryRun).toBe(true);
	});

	it('--renderer selects the up renderer mode', () => {
		const f = parseGlobalFlags(['--renderer', 'plain', 'up'], emptyEnv);
		expect(f.renderer).toBe('plain');
		expect(f.rest).toEqual(['up']);
	});

	it('DEVSTACK_RENDERER selects the up renderer mode', () => {
		const f = parseGlobalFlags(['up'], {
			env: { [ENV_VARS.RENDERER]: 'silent' },
			stdinIsTty: true,
		});
		expect(f.renderer).toBe('silent');
	});

	it('rejects invalid renderer values', () => {
		expect(() => parseGlobalFlags(['--renderer', 'ansi', 'up'], emptyEnv)).toThrow(CliUsageError);
	});

	it('--schema short-circuit flag captured', () => {
		const f = parseGlobalFlags(['--schema', '--json'], emptyEnv);
		expect(f.schemaEmit).toBe(true);
		expect(f.outputMode).toBe('json');
	});
});

describe('subcommand-flag helpers', () => {
	it('takePositional pops first non-flag', () => {
		const r = takePositional(['--foo', 'bar', '--baz']);
		expect(r.head).toBe('bar');
		expect(r.tail).toEqual(['--foo', '--baz']);
	});

	it('takeBoolFlag matches long form', () => {
		const r = takeBoolFlag(['a', '--include-images', 'b'], 'include-images');
		expect(r.present).toBe(true);
		expect(r.tail).toEqual(['a', 'b']);
	});

	it('takeValueFlag supports inline =', () => {
		const r = takeValueFlag(['--label=v1', 'rest'], 'label');
		expect(r.value).toBe('v1');
		expect(r.tail).toEqual(['rest']);
	});

	it('takeValueFlag supports space-separated', () => {
		const r = takeValueFlag(['--label', 'v1', 'rest'], 'label');
		expect(r.value).toBe('v1');
		expect(r.tail).toEqual(['rest']);
	});
});
