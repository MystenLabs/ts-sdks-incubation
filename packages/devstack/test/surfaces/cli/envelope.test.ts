// JSON envelope schema + serialization invariants.
//
// Architecture (distilled/20-cli.md § Invariants):
//   - schemaVersion pinned
//   - absent fields OMITTED (not null) from serialized output
//   - exactly one envelope per command (caller's responsibility,
//     but the shape must support it)
//   - never carries devstack-internal types
//
// These tests are the regression net for the public envelope schema —
// any breaking change forces an explicit schema-version bump.

import { describe, expect, it } from 'vitest';

import {
	ENVELOPE_SCHEMA_VERSION,
	failureEnvelope,
	successEnvelope,
} from '../../../src/surfaces/cli/envelope.ts';
import { ExitCode } from '../../../src/surfaces/cli/sysexits.ts';
import { serializeEnvelope } from '../../../src/surfaces/cli/output.ts';

describe('success envelope', () => {
	it('schemaVersion is pinned', () => {
		const env = successEnvelope({ command: 'status', elapsedMs: 0 });
		expect(env.schemaVersion).toBe(ENVELOPE_SCHEMA_VERSION);
	});

	it('omits optional fields when absent', () => {
		const env = successEnvelope({ command: 'status', elapsedMs: 5 });
		const json = JSON.parse(serializeEnvelope(env));
		expect(json).toEqual({
			schemaVersion: 1,
			ok: true,
			command: 'status',
			elapsedMs: 5,
		});
		expect('data' in json).toBe(false);
		expect('hints' in json).toBe(false);
		expect('dryRun' in json).toBe(false);
		expect('error' in json).toBe(false);
	});

	it('includes data when provided', () => {
		const env = successEnvelope({
			command: 'snapshot list',
			elapsedMs: 0,
			data: { count: 3 },
		});
		const json = JSON.parse(serializeEnvelope(env));
		expect(json.data).toEqual({ count: 3 });
	});

	it('omits empty hints array', () => {
		const env = successEnvelope({
			command: 'status',
			elapsedMs: 0,
			hints: [],
		});
		expect('hints' in env).toBe(false);
	});

	it('dryRun only present when true', () => {
		const a = successEnvelope({ command: 'prune', elapsedMs: 0, dryRun: false });
		const b = successEnvelope({ command: 'prune', elapsedMs: 0, dryRun: true });
		expect('dryRun' in a).toBe(false);
		expect(b.dryRun).toBe(true);
	});
});

describe('failure envelope', () => {
	it('error.code mirrors sysexit name', () => {
		const env = failureEnvelope({
			command: 'up',
			elapsedMs: 1,
			exitCode: ExitCode.CONFIG,
			summary: 'bad config',
		});
		expect(env.error?.code).toBe('CONFIG');
		expect(env.error?.exitCode).toBe(78);
	});

	it('omits absent hint / recipe / chain', () => {
		const env = failureEnvelope({
			command: 'up',
			elapsedMs: 1,
			exitCode: ExitCode.USAGE,
			summary: 'bad usage',
		});
		const json = JSON.parse(serializeEnvelope(env));
		expect('hint' in json.error).toBe(false);
		expect('recipe' in json.error).toBe(false);
		expect('chain' in json.error).toBe(false);
	});

	it('includes chain when provided', () => {
		const env = failureEnvelope({
			command: 'up',
			elapsedMs: 1,
			exitCode: ExitCode.SOFTWARE,
			summary: 'crash',
			chain: ['boom', '  caused by:', '    inner'],
		});
		expect(env.error?.chain).toEqual(['boom', '  caused by:', '    inner']);
	});
});

describe('serializer guards against undefined leaking', () => {
	it('strips undefined from serialized output', () => {
		const value = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
		const serialized = JSON.parse(serializeEnvelope(value as never));
		expect(serialized).toEqual({ a: 1, c: { e: 2 } });
	});
});
