// `stripPinnedSections` is the load-bearing pure function inside
// `scrubLockFileIfPresent` / `scrubMoveLock`. Both legacy `[env]` /
// `[env.<name>]` sections (v3 Move.lock format) AND v4-flat
// `[pinned.<env>.<pkg>]` sections embed a network-pinned package id
// that, if left in place, ends up baked into the bytecode at
// `sui move build` time — the publish then fails on a fresh localnet
// because the testnet/mainnet ids aren't on chain. This file pins the
// transform's behavior so regressions in the parser surface here
// instead of as opaque publish failures inside an example's
// `move build`.

import { describe, expect, it } from '@effect/vitest';
import { stripPinnedSections } from './sui-cli.js';

describe('stripPinnedSections', () => {
	it('strips v4-flat [pinned.<env>.<pkg>] sections', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[pinned.testnet.token]',
			'source = { git = "..." }',
			'original-id = "0xabc"',
			'published-at = "0xdef"',
			'',
			'[pinned.testnet.deepbook]',
			'original-id = "0x123"',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('original-id');
		expect(output).not.toContain('published-at');
		// Non-stripped section preserved.
		expect(output).toContain('[move]');
		expect(output).toContain('version = 4');
	});

	it('strips legacy [env] and [env.<name>] sections', () => {
		const input = [
			'[move]',
			'version = 3',
			'',
			'[env]',
			'default = "testnet"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
			'original-published-id = "0xabc"',
			'latest-published-id = "0xdef"',
			'published-version = "1"',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[env]');
		expect(output).not.toContain('[env.testnet]');
		expect(output).not.toContain('chain-id');
		expect(output).not.toContain('original-published-id');
		expect(output).toContain('[move]');
		expect(output).toContain('version = 3');
	});

	it('strips both pinned and env sections from a mixed file, preserves the rest verbatim', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[[move.toolchain-version]]',
			'compiler-version = "1.71.0"',
			'edition = "2024"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
			'',
			'[pinned.testnet.token]',
			'original-id = "0xabc"',
			'',
			'[[move.dependencies]]',
			'name = "Sui"',
			'source = { local = "../sui-framework" }',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[env.');
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('chain-id');
		expect(output).not.toContain('original-id');
		// Non-stripped sections preserved with their bodies.
		expect(output).toContain('[[move.toolchain-version]]');
		expect(output).toContain('compiler-version = "1.71.0"');
		expect(output).toContain('[[move.dependencies]]');
		expect(output).toContain('source = { local = "../sui-framework" }');
	});

	it('is idempotent: stripping a scrubbed file returns the same string', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[pinned.testnet.token]',
			'original-id = "0xabc"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
		].join('\n');

		const once = stripPinnedSections(input);
		const twice = stripPinnedSections(once);
		expect(twice).toBe(once);
	});

	it('matches headers tolerantly of leading whitespace (tabs and spaces)', () => {
		// Move.lock files in the wild are normally flush-left, but the
		// parser uses `trimStart()` before matching so indented sections
		// also get stripped. Pin that behavior — a regression that
		// matched only `^[\[`-prefixed lines would silently leak
		// indented `[pinned.*]` sections through.
		const input = [
			'[move]',
			'version = 4',
			'',
			'\t[pinned.testnet.token]',
			'\toriginal-id = "0xabc"',
			'',
			'  [env.testnet]',
			'  chain-id = "4c78adac"',
			'',
			'[after]',
			'keep = true',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('[env.');
		expect(output).not.toContain('original-id');
		expect(output).not.toContain('chain-id');
		// The `[after]` section must survive — proves we don't keep
		// `skipping` set after the indented section ends.
		expect(output).toContain('[after]');
		expect(output).toContain('keep = true');
	});

	it('leaves a file without any pinned/env sections unchanged', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[[move.dependencies]]',
			'name = "Sui"',
		].join('\n');
		expect(stripPinnedSections(input)).toBe(input);
	});
});
