// CLI surface smoke test. Production-readiness review flagged: "confirm
// `--help` lists every command". The runtime check is straightforward
// (`node dist/cli/main.mjs --help` against a hardcoded list), but the
// risk this test guards is regression: a refactor that drops a
// `Command.withSubcommands` entry, renames a verb, or stops wiring a
// command into the root tree should fail in CI rather than ship a CLI
// with a silently-missing verb.
//
// `Command.Any.subcommands` exposes the post-`withSubcommands` group
// structure (see `repos/effect-v4/.../Command.ts:272`), so we can walk
// the tree without invoking the parser or spawning a node child.

import { describe, expect, it } from 'vitest';
import type { Command } from 'effect/unstable/cli';
import { rootCommand } from './index.js';

const collectSubcommandNames = (cmd: Command.Command.Any): ReadonlyArray<string> =>
	cmd.subcommands.flatMap((group) => group.commands.map((c) => c.name));

describe('CLI surface', () => {
	it('exposes every documented top-level subcommand', () => {
		// Locked list — production-readiness wants every verb reachable from
		// `devstack --help`. Add new entries here when a verb lands; remove
		// (with a changeset) when one is intentionally retired.
		const expected = [
			'up',
			'apply',
			'status',
			'snapshot',
			'wipe',
			'stack',
			'doctor',
			'manifest',
			'version',
		];
		const got = collectSubcommandNames(rootCommand);
		expect(got).toEqual(expected);
	});

	it('every top-level command has a description (renders under `--help`)', () => {
		// `Command.withDescription` is what `--help` prints next to each
		// verb. A missing description renders as a blank line in the SUBCOMMANDS
		// section — easy to miss in review.
		for (const group of rootCommand.subcommands) {
			for (const cmd of group.commands) {
				expect(cmd.description, `command '${cmd.name}' is missing a description`).toBeDefined();
				expect(cmd.description?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	it('exposes every `snapshot` subcommand', () => {
		const snapshot = rootCommand.subcommands
			.flatMap((g) => g.commands)
			.find((c) => c.name === 'snapshot');
		expect(snapshot, '`snapshot` command must be registered on the root').toBeDefined();
		expect(collectSubcommandNames(snapshot!)).toEqual(['save', 'restore', 'list', 'delete']);
	});

	it('exposes every `stack` subcommand', () => {
		const stack = rootCommand.subcommands
			.flatMap((g) => g.commands)
			.find((c) => c.name === 'stack');
		expect(stack, '`stack` command must be registered on the root').toBeDefined();
		expect(collectSubcommandNames(stack!)).toEqual(['list', 'new', 'use', 'down', 'drop']);
	});
});
