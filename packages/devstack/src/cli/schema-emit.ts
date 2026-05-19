// `devstack --schema --json` — full machine-readable description of the
// command tree. Agents call this once to autodiscover every verb,
// every flag, and every exit code without scraping `--help`.
//
// Shape (versioned via the envelope's `schemaVersion`):
//
//   {
//     schemaVersion: 1,
//     version: "0.0.0",
//     envelope: { ... shape definition ... },
//     exitCodes: [{ code, name, description }],
//     commands: [{ name, description?, subcommands: [...] }]
//   }
//
// Read-only — does NOT build any layers, parse any user input beyond
// the introspection invocation.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Command } from 'effect/unstable/cli';
import {
	ALL_EXIT_CODES,
	exitCodeDescription,
	exitCodeName,
	type ExitCode,
} from './exit-codes.js';
import { ENVELOPE_SCHEMA_VERSION } from './envelope.js';

interface SchemaCommand {
	readonly name: string;
	readonly description?: string;
	readonly subcommands: ReadonlyArray<SchemaCommand>;
}

interface SchemaExitCode {
	readonly code: ExitCode;
	readonly name: string;
	readonly description: string;
}

interface SchemaEnvelope {
	readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
	readonly fields: {
		readonly ok: 'boolean';
		readonly command: 'string';
		readonly data: 'unknown (per-command)';
		readonly error: {
			readonly code: 'string';
			readonly exitCode: 'number';
			readonly message: 'string';
			readonly hint: 'string?';
			readonly recipe: 'string?';
			readonly cause: 'unknown?';
			readonly context: 'Record<string, unknown>?';
		};
		readonly hints: 'ReadonlyArray<string>?';
		readonly elapsedMs: 'number';
		readonly dryRun: 'boolean?';
	};
}

interface Schema {
	readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
	readonly version: string;
	readonly envelope: SchemaEnvelope;
	readonly exitCodes: ReadonlyArray<SchemaExitCode>;
	readonly globalEnv: ReadonlyArray<{ readonly name: string; readonly description: string }>;
	readonly commands: ReadonlyArray<SchemaCommand>;
}

/** Walk a `Command` and project name/description/subcommands into the
 *  JSON-serialisable shape above. Flag introspection is omitted today
 *  because effect's CLI surface keeps the flag table behind a private
 *  field — Phase B may stabilize the shape and we wire it through then. */
const projectCommand = (cmd: Command.Command.Any): SchemaCommand => {
	const subs: Array<SchemaCommand> = [];
	for (const group of cmd.subcommands) {
		for (const sub of group.commands) {
			subs.push(projectCommand(sub));
		}
	}
	return {
		name: cmd.name,
		...(cmd.description !== undefined ? { description: cmd.description } : {}),
		subcommands: subs,
	};
};

/** Build the full schema object for `--schema --json`. */
export const buildSchema = (input: {
	readonly root: Command.Command.Any;
	readonly version: string;
}): Schema => ({
	schemaVersion: ENVELOPE_SCHEMA_VERSION,
	version: input.version,
	envelope: {
		schemaVersion: ENVELOPE_SCHEMA_VERSION,
		fields: {
			ok: 'boolean',
			command: 'string',
			data: 'unknown (per-command)',
			error: {
				code: 'string',
				exitCode: 'number',
				message: 'string',
				hint: 'string?',
				recipe: 'string?',
				cause: 'unknown?',
				context: 'Record<string, unknown>?',
			},
			hints: 'ReadonlyArray<string>?',
			elapsedMs: 'number',
			dryRun: 'boolean?',
		},
	},
	exitCodes: ALL_EXIT_CODES.map((code) => ({
		code,
		name: exitCodeName(code),
		description: exitCodeDescription(code),
	})),
	globalEnv: [
		{
			name: 'DEVSTACK_STACK',
			description: 'Override the active stack name (precedence: --stack > env > .devstack/active > "main")',
		},
		{
			name: 'DEVSTACK_APP_DIR',
			description: 'Override the app directory (where .devstack/ lives)',
		},
		{
			name: 'DEVSTACK_STATE_DIR',
			description: 'Override the .devstack/ state directory location',
		},
		{
			name: 'DEVSTACK_NETWORK',
			description: 'Target Sui network: localnet | testnet | mainnet | *-fork',
		},
		{
			name: 'DEVSTACK_MANIFEST_PATH',
			description: 'Override the manifest.json discovery walk-up',
		},
		{
			name: 'DEVSTACK_JSON',
			description: 'Set to "1" to force --json on every command (CI default)',
		},
		{
			name: 'DEVSTACK_NO_INPUT',
			description: 'Set to "1" to force --no-input on every command (CI default)',
		},
		{
			name: 'NO_COLOR',
			description: 'Standard clig.dev escape — disable ANSI color',
		},
	],
	commands: input.root.subcommands.flatMap((group) =>
		group.commands.map((c) => projectCommand(c)),
	),
});

/** Serialize the schema as a single JSON string. */
export const renderSchema = (input: {
	readonly root: Command.Command.Any;
	readonly version: string;
}): string => JSON.stringify(buildSchema(input));
