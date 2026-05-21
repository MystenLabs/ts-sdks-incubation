// Permission-policy tests.

import { describe, expect, it } from '@effect/vitest';

import {
	anySensitive,
	dirModeFor,
	modeFor,
	NON_SENSITIVE_DIR_MODE,
	NON_SENSITIVE_FILE_MODE,
	SENSITIVE_DIR_MODE,
	SENSITIVE_FILE_MODE,
} from '../../../src/orchestrators/codegen/permissions.ts';

describe('permissions', () => {
	it('sensitive=true → 0o600', () => {
		expect(modeFor({ sensitive: true })).toBe(SENSITIVE_FILE_MODE);
		expect(SENSITIVE_FILE_MODE).toBe(0o600);
	});

	it('sensitive=false or absent → 0o644', () => {
		expect(modeFor({ sensitive: false })).toBe(NON_SENSITIVE_FILE_MODE);
		expect(modeFor({})).toBe(NON_SENSITIVE_FILE_MODE);
		expect(NON_SENSITIVE_FILE_MODE).toBe(0o644);
	});

	it('dir mode tightens to 0o700 if any file is sensitive', () => {
		expect(dirModeFor([{ sensitive: false }, { sensitive: true }])).toBe(SENSITIVE_DIR_MODE);
		expect(dirModeFor([{ sensitive: false }, { sensitive: false }])).toBe(NON_SENSITIVE_DIR_MODE);
		expect(SENSITIVE_DIR_MODE).toBe(0o700);
		expect(NON_SENSITIVE_DIR_MODE).toBe(0o755);
	});

	it('anySensitive reflects mixed/empty sets', () => {
		expect(anySensitive([])).toBe(false);
		expect(anySensitive([{ sensitive: false }])).toBe(false);
		expect(anySensitive([{ sensitive: true }, { sensitive: false }])).toBe(true);
	});
});
