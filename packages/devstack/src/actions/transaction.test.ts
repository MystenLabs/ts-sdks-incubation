// Unit tests for `runTransaction`'s default marker-file idempotence.
// Doesn't drive a live sui chain — instead asserts on the action's
// `getStatus` against fabricated marker file states.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ActionRunContext } from '../core/types.js';
import { stableHash } from '../runtime/hash.js';
import { runTransaction } from './transaction.js';

function fabricateCtx(appDir: string, stack = 'main'): ActionRunContext {
	// Minimal localnet ctx — runTransaction's default getStatus only
	// reads ctx.network, ctx.appDir, ctx.stack. Everything else is
	// unreached so the casts below are safe.
	return {
		appName: 'fixture',
		appDir,
		stack,
		network: 'localnet',
		registry: undefined as never,
		accounts: undefined as never,
		ports: undefined as never,
	};
}

function withTempAppDir<T>(fn: (appDir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-runtx-test-'));
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function expectedHashFor(opts: {
	signer: string;
	build: (...args: unknown[]) => unknown;
	scope?: string;
	needs?: string[];
}): string {
	return stableHash({
		signer: opts.signer,
		build: opts.build.toString(),
		scope: opts.scope ?? 'always',
		needs: opts.needs ?? [],
	});
}

describe('runTransaction default marker probe', () => {
	it('returns ok:false when marker is absent', async () => {
		await withTempAppDir(async (appDir) => {
			const action = runTransaction({
				name: 'mint',
				signer: 'alice',
				build: () => {},
			});
			const result = await action.getStatus!(fabricateCtx(appDir));
			expect(result.ok).toBe(false);
			expect(result.detail).toMatch(/absent/);
		});
	});

	it('returns ok:true when marker matches the inputs hash', async () => {
		await withTempAppDir(async (appDir) => {
			const build = () => {};
			const action = runTransaction({ name: 'mint', signer: 'alice', build });
			const expected = expectedHashFor({ signer: 'alice', build });
			const path = resolve(appDir, '.devstack/stacks/main/setup/mint.done');
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, `${expected}\n`, 'utf8');
			const result = await action.getStatus!(fabricateCtx(appDir));
			expect(result.ok).toBe(true);
		});
	});

	it('invalidates the marker when the build callback changes (the footgun fix)', async () => {
		await withTempAppDir(async (appDir) => {
			// Real source-different bodies — different parameter names so
			// even aggressive minifiers can't collapse them.
			const oldBuild = function buildVOne() {
				return undefined;
			};
			const oldHash = expectedHashFor({ signer: 'alice', build: oldBuild });
			const path = resolve(appDir, '.devstack/stacks/main/setup/mint.done');
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, `${oldHash}\n`, 'utf8');

			// User edits the callback — different source, different hash.
			const newBuild = function buildVTwo() {
				return undefined;
			};
			expect(oldBuild.toString()).not.toBe(newBuild.toString());
			const action = runTransaction({ name: 'mint', signer: 'alice', build: newBuild });
			const result = await action.getStatus!(fabricateCtx(appDir));
			expect(result.ok).toBe(false);
			expect(result.detail).toMatch(/inputs changed/);
		});
	});

	it('invalidates the marker when the signer changes', async () => {
		await withTempAppDir(async (appDir) => {
			const build = () => {};
			const oldHash = expectedHashFor({ signer: 'alice', build });
			const path = resolve(appDir, '.devstack/stacks/main/setup/mint.done');
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, `${oldHash}\n`, 'utf8');

			const action = runTransaction({ name: 'mint', signer: 'bob', build });
			const result = await action.getStatus!(fabricateCtx(appDir));
			expect(result.ok).toBe(false);
			expect(result.detail).toMatch(/inputs changed/);
		});
	});

	it('respects per-stack marker isolation', async () => {
		await withTempAppDir(async (appDir) => {
			const build = () => {};
			const action = runTransaction({ name: 'mint', signer: 'alice', build });
			const hash = expectedHashFor({ signer: 'alice', build });

			// Marker exists only in main — test stack should still be ok:false.
			const mainPath = resolve(appDir, '.devstack/stacks/main/setup/mint.done');
			mkdirSync(resolve(mainPath, '..'), { recursive: true });
			writeFileSync(mainPath, `${hash}\n`, 'utf8');

			const main = await action.getStatus!(fabricateCtx(appDir, 'main'));
			expect(main.ok).toBe(true);
			const test = await action.getStatus!(fabricateCtx(appDir, 'test'));
			expect(test.ok).toBe(false);
		});
	});
});
