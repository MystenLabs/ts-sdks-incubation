// Allowlist is the security boundary that keeps secrets (AWS creds,
// MASTER_KEY, etc.) out of spawned plugin processes — regressions are
// silent leaks, so it gets a dedicated unit test.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { inheritedHostEnv } from './safe-env.js';

describe('inheritedHostEnv', () => {
	let saved: NodeJS.ProcessEnv;

	beforeEach(() => {
		saved = { ...process.env };
	});

	afterEach(() => {
		// Restore wholesale — undoes both deletes and additions in one shot.
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, saved);
	});

	it('forwards allowed POSIX entries when set', () => {
		process.env.PATH = '/usr/bin:/bin';
		process.env.HOME = '/home/test';
		process.env.SHELL = '/bin/zsh';
		process.env.LANG = 'en_US.UTF-8';
		const env = inheritedHostEnv();
		expect(env.PATH).toBe('/usr/bin:/bin');
		expect(env.HOME).toBe('/home/test');
		expect(env.SHELL).toBe('/bin/zsh');
		expect(env.LANG).toBe('en_US.UTF-8');
	});

	it('strips disallowed entries (secrets must not leak)', () => {
		process.env.AWS_SECRET_ACCESS_KEY = 'shh';
		process.env.MASTER_KEY = 'do-not-leak';
		process.env.GITHUB_TOKEN = 'ghp_x';
		process.env.MY_CUSTOM_VAR = 'nope';
		const env = inheritedHostEnv();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.MASTER_KEY).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.MY_CUSTOM_VAR).toBeUndefined();
	});

	it('omits unset allowed entries instead of emitting undefined values', () => {
		delete process.env.TMPDIR;
		delete process.env.OLDPWD;
		const env = inheritedHostEnv();
		expect('TMPDIR' in env).toBe(false);
		expect('OLDPWD' in env).toBe(false);
		// `undefined` slots break child-process spawn on some platforms.
		for (const v of Object.values(env)) expect(v).not.toBeUndefined();
	});

	it('forwards Windows-specific entries (USERPROFILE, APPDATA) when set', () => {
		process.env.USERPROFILE = 'C:\\Users\\test';
		process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
		process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
		const env = inheritedHostEnv();
		expect(env.USERPROFILE).toBe('C:\\Users\\test');
		expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
		expect(env.LOCALAPPDATA).toBe('C:\\Users\\test\\AppData\\Local');
	});
});
