// Unit tests for the walrus cargo-image lifted-sibling key derivation.
// The (plugin, kind, scope, inputHash) tuple drives first-wins dedup
// across composites + compile-time conflict refusal — this test pins
// the shape so the type-level conflict refusal stays sound after a
// refactor.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_RUST_TOOLCHAIN,
	DEFAULT_SUI_VERSION,
	defaultWalrusCargoImageSiblingKey,
	walrusCargoImageSiblingKey,
} from '../../../src/plugins/walrus/lifted-siblings/cargo-image.ts';
import { DEFAULT_WALRUS_REF } from '../../../src/plugins/walrus/lifted-siblings/source-fetch.ts';

describe('walrusCargoImageSiblingKey', () => {
	it('folds (ref, sui, rust) into the inputHash', () => {
		const k = walrusCargoImageSiblingKey('vA', 'vB', 'vC');
		expect(k.plugin).toBe('walrus');
		expect(k.kind).toBe('cargo-image');
		expect(k.scope).toBe('per-process');
		expect(k.inputHash).toBe('vA|vB|vC');
	});

	it('two composites with the SAME triple share one key (dedup target)', () => {
		const a = walrusCargoImageSiblingKey('x', 'y', 'z');
		const b = walrusCargoImageSiblingKey('x', 'y', 'z');
		// Same shape — substrate uses structural compare to dedup.
		expect(a.plugin).toBe(b.plugin);
		expect(a.kind).toBe(b.kind);
		expect(a.scope).toBe(b.scope);
		expect(a.inputHash).toBe(b.inputHash);
	});

	it('two composites with DIFFERENT refs surface DIFFERENT inputHashes', () => {
		const a = walrusCargoImageSiblingKey('vA', 'vB', 'vC');
		const b = walrusCargoImageSiblingKey('vA2', 'vB', 'vC');
		expect(a.inputHash).not.toBe(b.inputHash);
	});

	it('default key uses the pinned defaults', () => {
		const k = defaultWalrusCargoImageSiblingKey();
		expect(k.inputHash).toBe(
			`${DEFAULT_WALRUS_REF}|${DEFAULT_SUI_VERSION}|${DEFAULT_RUST_TOOLCHAIN}`,
		);
	});

	it('default release is pinned to a tarball that includes walrus-deploy', () => {
		expect(DEFAULT_WALRUS_REF).toBe('devnet-v1.49.0');
	});

	it('vendored image fails during build if the release omits required binaries', () => {
		const dockerfile = readFileSync(
			new URL('../../../images/walrus/Dockerfile', import.meta.url),
			'utf8',
		);
		expect(dockerfile).toContain('for bin in walrus walrus-node walrus-deploy');
		expect(dockerfile).toContain('missing required binary');
	});
});
