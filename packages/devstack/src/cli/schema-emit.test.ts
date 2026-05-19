// `cli/schema-emit` — agent autodiscovery payload tests.
//
// `devstack --schema --json` is the agent-facing entry point for the
// command tree. Production-readiness wants:
//
//   1. The payload is valid JSON (parsable by `JSON.parse`).
//   2. The shape carries `schemaVersion`, `version`, `envelope`,
//      `exitCodes`, `globalEnv`, `commands`.
//   3. Every top-level subcommand the CLI registers appears in
//      `commands`.
//   4. Nested subcommands (snapshot, stack, fork) are reachable from
//      the projection.
//   5. The `exitCodes` table maps each numeric code to a name +
//      description.

import { describe, expect, it } from 'vitest';
import { rootCommand } from './index.js';
import { buildSchema, renderSchema } from './schema-emit.js';

describe('cli/schema-emit', () => {
	it('renderSchema produces parseable JSON', () => {
		const text = renderSchema({ root: rootCommand, version: '0.0.0' });
		// Throws on bad JSON — that's the assertion.
		const parsed = JSON.parse(text) as { schemaVersion: number };
		expect(parsed.schemaVersion).toBe(1);
	});

	it('schema carries every documented top-level field', () => {
		const schema = buildSchema({ root: rootCommand, version: '0.0.0' });
		expect(schema.schemaVersion).toBe(1);
		expect(schema.version).toBe('0.0.0');
		expect(schema.envelope.schemaVersion).toBe(1);
		expect(schema.envelope.fields.ok).toBe('boolean');
		expect(schema.envelope.fields.error.code).toBe('string');
		expect(schema.exitCodes.length).toBeGreaterThan(0);
		expect(schema.globalEnv.length).toBeGreaterThan(0);
		expect(schema.commands.length).toBeGreaterThan(0);
	});

	it('lists every top-level subcommand', () => {
		const schema = buildSchema({ root: rootCommand, version: '0.0.0' });
		const names = schema.commands.map((c) => c.name);
		expect(names).toContain('up');
		expect(names).toContain('apply');
		expect(names).toContain('status');
		expect(names).toContain('snapshot');
		expect(names).toContain('wipe');
		expect(names).toContain('prune');
		expect(names).toContain('stack');
		expect(names).toContain('fork');
		expect(names).toContain('doctor');
		expect(names).toContain('manifest');
		expect(names).toContain('graph');
	});

	it('projects nested subcommands (snapshot.save / stack.list / fork.seed.diff)', () => {
		const schema = buildSchema({ root: rootCommand, version: '0.0.0' });
		const snapshot = schema.commands.find((c) => c.name === 'snapshot');
		expect(snapshot?.subcommands.map((c) => c.name)).toEqual([
			'save',
			'restore',
			'list',
			'delete',
		]);
		const stack = schema.commands.find((c) => c.name === 'stack');
		expect(stack?.subcommands.map((c) => c.name)).toContain('list');
		const fork = schema.commands.find((c) => c.name === 'fork');
		const seed = fork?.subcommands.find((c) => c.name === 'seed');
		expect(seed?.subcommands.map((c) => c.name)).toEqual(['list', 'diff']);
	});

	it('every exit code carries name + description', () => {
		const schema = buildSchema({ root: rootCommand, version: '0.0.0' });
		for (const entry of schema.exitCodes) {
			expect(typeof entry.code).toBe('number');
			expect(entry.name).toMatch(/^EX_/);
			expect(entry.description.length).toBeGreaterThan(0);
		}
	});

	it('documents every canonical env var', () => {
		const schema = buildSchema({ root: rootCommand, version: '0.0.0' });
		const names = new Set(schema.globalEnv.map((e) => e.name));
		expect(names.has('DEVSTACK_STACK')).toBe(true);
		expect(names.has('DEVSTACK_JSON')).toBe(true);
		expect(names.has('DEVSTACK_NO_INPUT')).toBe(true);
		expect(names.has('NO_COLOR')).toBe(true);
	});
});
