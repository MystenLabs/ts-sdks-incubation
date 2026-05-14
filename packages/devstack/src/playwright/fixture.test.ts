import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDevstackTest } from './fixture.js';
import { webServer } from './web-server.js';

// We can't drive Playwright's worker runtime from vitest, so these
// tests verify the factory's API surface + the webServer() helper's
// failure-loud semantics. End-to-end behavior is covered by the
// examples' actual `pnpm test:e2e` runs.

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-pw-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

describe('createDevstackTest', () => {
	it('returns a Playwright TestType', () => {
		const test = createDevstackTest();
		expect(typeof test).toBe('function');
		expect(typeof test.extend).toBe('function');
		expect(typeof test.beforeAll).toBe('function');
	});

	it('accepts a custom stackName pattern', () => {
		const test = createDevstackTest({ stackName: (idx) => `custom-${idx}` });
		expect(typeof test).toBe('function');
	});
});

describe('webServer', () => {
	async function seedManifest(
		stack: string,
		endpoints: Array<{ name: string; url: string }>,
	): Promise<string> {
		const dir = join(appDir, '.devstack', 'stacks', stack);
		await mkdir(dir, { recursive: true });
		const path = join(dir, 'manifest.json');
		await writeFile(
			path,
			JSON.stringify({
				packages: [],
				endpoints,
				accounts: [],
				coins: [],
				extras: {},
			}),
		);
		return path;
	}

	it('returns a webServer config sourced from the named endpoint', async () => {
		const manifestPath = await seedManifest('test', [
			{ name: 'vite-dev', url: 'http://localhost:5173' },
		]);
		const cfg = webServer({ endpoint: 'vite-dev', manifestPath });
		// The returned config could be a single or array shape per the
		// Playwright type; narrow accordingly.
		const single = Array.isArray(cfg) ? cfg[0]! : cfg;
		expect(single.url).toBe('http://localhost:5173');
		expect(single.command).toBe('pnpm dev');
		expect(single.timeout).toBe(120_000);
	});

	it('honors `command` and `timeout` overrides', async () => {
		const manifestPath = await seedManifest('test', [
			{ name: 'vite-dev', url: 'http://localhost:5174' },
		]);
		const cfg = webServer({
			endpoint: 'vite-dev',
			manifestPath,
			command: 'pnpm preview',
			timeout: 5_000,
		});
		const single = Array.isArray(cfg) ? cfg[0]! : cfg;
		expect(single.command).toBe('pnpm preview');
		expect(single.timeout).toBe(5_000);
	});

	it('throws loudly when manifest file does not exist', () => {
		expect(() =>
			webServer({
				endpoint: 'vite-dev',
				manifestPath: join(appDir, '.devstack/stacks/test/manifest.json'),
			}),
		).toThrow(/manifest not found/);
	});

	it('throws loudly when the named endpoint is missing from the manifest', async () => {
		const manifestPath = await seedManifest('test', [
			{ name: 'something-else', url: 'http://localhost:9999' },
		]);
		expect(() => webServer({ endpoint: 'vite-dev', manifestPath })).toThrow(
			/no endpoint 'vite-dev'/,
		);
	});

	it('error message lists available endpoint names for actionable feedback', async () => {
		const manifestPath = await seedManifest('test', [
			{ name: 'sui-rpc', url: 'http://localhost:9000' },
			{ name: 'wallet-app', url: 'http://localhost:5175' },
		]);
		expect(() => webServer({ endpoint: 'vite-dev', manifestPath })).toThrow(/sui-rpc, wallet-app/);
	});
});
