import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_STACK,
	TEST_STACK,
	activeStackFile,
	readActiveStack,
	resolveStack,
	stackDir,
	writeActiveStack,
} from './active-stack.js';

let tmpDirs: string[] = [];

const newAppDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-active-stack-'));
	tmpDirs.push(dir);
	return dir;
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe('active-stack — constants', () => {
	it('DEFAULT_STACK is "main" and TEST_STACK is "test"', () => {
		expect(DEFAULT_STACK).toBe('main');
		expect(TEST_STACK).toBe('test');
	});
});

describe('activeStackFile', () => {
	it('returns a stable path under <appDir>/.devstack/active', () => {
		expect(activeStackFile('/tmp/app')).toBe(join('/tmp/app', '.devstack', 'active'));
	});
});

describe('stackDir', () => {
	it('returns <appDir>/.devstack/stacks/<stack>', () => {
		expect(stackDir('/tmp/app', 'main')).toBe(join('/tmp/app', '.devstack', 'stacks', 'main'));
		expect(stackDir('/tmp/app', 'feature-x')).toBe(
			join('/tmp/app', '.devstack', 'stacks', 'feature-x'),
		);
	});
});

describe('writeActiveStack + readActiveStack', () => {
	it('round-trips: writeActiveStack then readActiveStack returns the name', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'feature-x');
		expect(readActiveStack(appDir)).toBe('feature-x');
	});

	it('readActiveStack returns DEFAULT_STACK when the file does not exist', () => {
		const appDir = newAppDir();
		expect(readActiveStack(appDir)).toBe(DEFAULT_STACK);
	});

	it('writeActiveStack creates the .devstack directory if missing', () => {
		const appDir = newAppDir();
		// No prior .devstack/ exists; writeActiveStack must mkdir -p.
		expect(() => writeActiveStack(appDir, 'fresh')).not.toThrow();
		expect(readActiveStack(appDir)).toBe('fresh');
	});

	it('writeActiveStack overwrites a previously written value', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'first');
		writeActiveStack(appDir, 'second');
		expect(readActiveStack(appDir)).toBe('second');
	});
});

describe('resolveStack — precedence', () => {
	it('uses the flag when provided (highest precedence)', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'from-file');
		vi.stubEnv('DEVSTACK_STACK', 'from-env');
		expect(resolveStack({ appDir, flag: 'from-flag' })).toBe('from-flag');
	});

	it('uses DEVSTACK_STACK env var when flag is unset', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'from-file');
		vi.stubEnv('DEVSTACK_STACK', 'from-env');
		expect(resolveStack({ appDir })).toBe('from-env');
	});

	it('uses the pointer file when flag and env are unset', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'from-file');
		vi.stubEnv('DEVSTACK_STACK', '');
		expect(resolveStack({ appDir })).toBe('from-file');
	});

	it('falls back to DEFAULT_STACK when nothing is set', () => {
		const appDir = newAppDir();
		vi.stubEnv('DEVSTACK_STACK', '');
		expect(resolveStack({ appDir })).toBe(DEFAULT_STACK);
	});

	it('treats an empty-string flag as unset (falls through to env/file/default)', () => {
		const appDir = newAppDir();
		writeActiveStack(appDir, 'from-file');
		vi.stubEnv('DEVSTACK_STACK', '');
		expect(resolveStack({ appDir, flag: '' })).toBe('from-file');
	});
});
