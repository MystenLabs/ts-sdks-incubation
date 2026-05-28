// Unit tests for `keygen.ts` — the parser + redactor.
//
// These are pure-function tests; they don't need docker. They pin
// the byte format the REAL `seal-cli genkey` emits (per the upstream
// `crates/seal-cli/src/main.rs::GenkeyOutput::Display` impl, observed
// against seal-v0.6.6):
//
//     Master key: 0x<32-byte hex>     (64 chars)
//     Public key: 0x<96-byte hex>     (192 chars, BLS12-381 G2 uncompressed)
//
// And the redactor's case-insensitive line-level match for any
// `master[_-]?key` mention (distilled-doc invariant #16).
//
// Lives at `test/plugins/seal/keygen.test.ts` per the mirror-src/
// rule.

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	decodeHex,
	parseSealKeygenOutput,
	redactMasterKey,
} from '../../../src/plugins/seal/keygen.ts';

// Fixture widths match what the real seal-cli prints (observed
// against seal-v0.6.6 binary): master = 32 bytes scalar, public =
// 96 bytes BLS12-381 G2 uncompressed. The parser regex doesn't pin
// these widths — they're documented here for human readers.
const SAMPLE_MASTER = '1'.repeat(64);
const SAMPLE_PUBLIC = '2'.repeat(192);

describe('parseSealKeygenOutput — real seal-cli output format', () => {
	it('parses the canonical two-line output', async () => {
		const stdout = `Master key: 0x${SAMPLE_MASTER}\nPublic key: 0x${SAMPLE_PUBLIC}\n`;
		const result = await Effect.runPromise(parseSealKeygenOutput(stdout, 'seal'));
		expect(result.masterKey).toBe(SAMPLE_MASTER);
		expect(result.publicKey).toBe(SAMPLE_PUBLIC);
	});

	it('tolerates leading 0x absence', async () => {
		const stdout = `Master key: ${SAMPLE_MASTER}\nPublic key: ${SAMPLE_PUBLIC}\n`;
		const result = await Effect.runPromise(parseSealKeygenOutput(stdout, 'seal'));
		expect(result.masterKey).toBe(SAMPLE_MASTER);
		expect(result.publicKey).toBe(SAMPLE_PUBLIC);
	});

	it('fails with redacted stdout when Master key line is missing', async () => {
		const stdout = `Some other output\nPublic key: 0x${SAMPLE_PUBLIC}\n`;
		const exit = await Effect.runPromiseExit(parseSealKeygenOutput(stdout, 'seal'));
		expect(Exit.isFailure(exit)).toBe(true);
		// stdout in the error must be REDACTED — the test's stdout
		// fixture only carries a `Public key:` line, but we still
		// verify the failure surfaces a SealError with the keygen phase.
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		if (Option.isSome(errOpt)) {
			const err = errOpt.value;
			expect(err._tag).toBe('SealError');
			expect(err.phase).toBe('keygen');
		}
	});

	it('fails when Public key line is missing', async () => {
		const stdout = `Master key: 0x${SAMPLE_MASTER}\nSome other output\n`;
		const exit = await Effect.runPromiseExit(parseSealKeygenOutput(stdout, 'seal'));
		expect(exit._tag).toBe('Failure');
	});
});

describe('redactMasterKey — invariant #16 (master-key NEVER in error surfaces)', () => {
	it('redacts the canonical Master key line', () => {
		const redacted = redactMasterKey(`Master key: 0x${SAMPLE_MASTER}`);
		expect(redacted).not.toContain(SAMPLE_MASTER);
		expect(redacted).toBe('[REDACTED master key]');
	});

	it('redacts master_key (snake case)', () => {
		const redacted = redactMasterKey(`stored master_key=0x${SAMPLE_MASTER} successfully`);
		expect(redacted).not.toContain(SAMPLE_MASTER);
	});

	it('redacts master-key (kebab case)', () => {
		const redacted = redactMasterKey(`master-key written to disk`);
		expect(redacted).toContain('[REDACTED master key]');
	});

	it('redacts MasterKey (camelCase)', () => {
		const redacted = redactMasterKey(`MasterKey set successfully`);
		expect(redacted).toContain('[REDACTED master key]');
	});

	it('does NOT redact unrelated lines', () => {
		const input = 'Public key: 0xabc\nOther benign content';
		const redacted = redactMasterKey(input);
		expect(redacted).toBe(input);
	});

	it('redacts ONLY the master-key line in a multi-line capture', () => {
		const input = `Master key: 0x${SAMPLE_MASTER}\nPublic key: 0xabc\nOther info`;
		const redacted = redactMasterKey(input);
		expect(redacted).not.toContain(SAMPLE_MASTER);
		expect(redacted).toContain('Public key: 0xabc');
		expect(redacted).toContain('Other info');
	});

	// Defense-in-depth: the label-based pass misses any stray hex run
	// the upstream binary prints without a `master_key` label nearby
	// (e.g. a `log::info!("{}", master)` upstream regression). The
	// secondary high-entropy-hex pass catches any contiguous 64+ char
	// hex run so the unlabeled leak still surfaces redacted.
	it('redacts a 64-char hex run that has NO master-key label (high-entropy pass)', () => {
		// Note: ALL '1' chars makes the line trivially recognisable
		// for the assertion; the redactor doesn't gate on entropy, only
		// width — the comment in the source explains the trade-off.
		const stray = 'b'.repeat(64);
		const input = `INFO seal-cli: ${stray}\nready`;
		const redacted = redactMasterKey(input);
		expect(redacted).not.toContain(stray);
		expect(redacted).toContain('<REDACTED-HEX-RUN>');
		// non-secret context survives so log readers still get the
		// surrounding shape.
		expect(redacted).toContain('INFO seal-cli:');
		expect(redacted).toContain('ready');
	});

	it('redacts a 64+ hex run on its own line', () => {
		const stray = 'c'.repeat(96);
		const redacted = redactMasterKey(stray);
		expect(redacted).toBe('<REDACTED-HEX-RUN>');
	});

	// False-positive guard: legitimate short hex (e.g. a Sui object id
	// fragment like `0xabc` or even a 16-char hash) must NOT trip the
	// hex pass. Only 64+ char contiguous runs are treated as suspect.
	it('does NOT redact short hex object-id fragments', () => {
		const input = 'object_id: 0xabc123456789abcd (16 chars)';
		const redacted = redactMasterKey(input);
		expect(redacted).toBe(input);
	});

	// Combined pass: labeled line AND a stray hex run on the same input
	// — the label-pass owns the labeled line, the hex-pass owns the
	// stray, neither double-replaces the other.
	it('handles both labeled line and stray hex without double-replacing', () => {
		const stray = 'd'.repeat(80);
		const input = `Master key: 0x${SAMPLE_MASTER}\nleaked: ${stray}\nend`;
		const redacted = redactMasterKey(input);
		expect(redacted).not.toContain(SAMPLE_MASTER);
		expect(redacted).not.toContain(stray);
		expect(redacted).toContain('[REDACTED master key]');
		expect(redacted).toContain('<REDACTED-HEX-RUN>');
		expect(redacted).toContain('end');
	});
});

describe('decodeHex — minimal hex → bytes helper', () => {
	it('tolerates leading 0x', () => {
		expect(decodeHex('0xff00').length).toBe(2);
		expect(decodeHex('0xff00')[0]).toBe(0xff);
		expect(decodeHex('0xff00')[1]).toBe(0x00);
	});

	it('round-trips known-good hex', () => {
		const bytes = decodeHex('deadbeef');
		expect([...bytes]).toEqual([0xde, 0xad, 0xbe, 0xef]);
	});

	it('throws on odd-length input', () => {
		expect(() => decodeHex('abc')).toThrow(/odd-length/i);
	});
});
