// Regression test for the seal local-keygen default version.
//
// Pins: the default `version` flowed into the local-keygen plan +
// OTEL span attrs MUST be the real pinned version constant
// (`DEFAULT_SEAL_VERSION` from bootstrap-assets/source-fetch.ts), NOT
// a sentinel placeholder string. Distilled-doc invariant #11 — the
// version moves in lockstep with the cargo binary's `SEAL_VERSION`.
//
// `resolveLocalKeygenOptions` is a pure synchronous defaults helper —
// no Effect harness required.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SEAL_VERSION } from '../../../src/plugins/seal/bootstrap-assets/source-fetch.ts';
import { resolveLocalKeygenOptions } from '../../../src/plugins/seal/mode/local-keygen.ts';

describe('seal local-keygen — default version', () => {
	it('DEFAULT_SEAL_VERSION is a real pinned ref, not a sentinel', () => {
		expect(DEFAULT_SEAL_VERSION).not.toContain('<');
		expect(DEFAULT_SEAL_VERSION).not.toContain('>');
		expect(DEFAULT_SEAL_VERSION).toMatch(/^seal-v\d+\.\d+\.\d+$/);
	});

	it('resolveLocalKeygenOptions stamps DEFAULT_SEAL_VERSION when no version is supplied', () => {
		const resolved = resolveLocalKeygenOptions({}, DEFAULT_SEAL_VERSION);
		expect(resolved.version).toBe(DEFAULT_SEAL_VERSION);
	});

	it('caller-supplied version wins over the default', () => {
		const resolved = resolveLocalKeygenOptions({ version: 'seal-v9.9.9' }, DEFAULT_SEAL_VERSION);
		expect(resolved.version).toBe('seal-v9.9.9');
	});
});
