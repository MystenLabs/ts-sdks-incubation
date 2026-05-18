// web-server / baseURL helpers — drive the manifest discovery + endpoint
// resolution + cold-start fallback paths. These functions are
// load-bearing for every example app's Playwright config and were
// previously untested; recent fixes touched the cold-start branch
// (1daec503 — extras/url propagation + autoConnect defaults) and the
// SIGTERM graceful-shutdown wiring (41366505 — process-tree).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EndpointName } from '../runtime/endpoint-names.js';
import { baseURL, webServer } from './web-server.js';

// Narrow the union return type of webServer() — Playwright's webServer
// option is declared as `single | single[]`, and the conditional type
// doesn't distribute over the union, so the inferred return is the
// union too. Tests want the single-server shape.
type SingleServer = Extract<ReturnType<typeof webServer>, { command?: string }>;
const single = (cfg: ReturnType<typeof webServer>): SingleServer => cfg as SingleServer;

const v4Manifest = (overrides?: {
	devUrl?: string;
	walletUrl?: string;
	suiRpcUrl?: string;
}): unknown => ({
	version: 4,
	stack: { name: 'main', network: 'localnet', app: 'test-app' },
	services: {
		sui: {
			network: 'localnet',
			rpc: { url: overrides?.suiRpcUrl ?? 'http://sui.test-app.localhost:9000' },
		},
	},
	packages: {},
	accounts: {},
	coins: {},
	app: {
		extras: {},
		...(overrides?.devUrl !== undefined ? { dev: { url: overrides.devUrl } } : {}),
		...(overrides?.walletUrl !== undefined ? { wallet: { url: overrides.walletUrl } } : {}),
	},
});

describe('playwright web-server helpers', () => {
	let manifestDir: string;
	let manifestPath: string;
	let priorEnv: { manifest: string | undefined; stack: string | undefined };

	beforeEach(() => {
		manifestDir = mkdtempSync(joinPath(tmpdir(), 'devstack-webserver-test-'));
		manifestPath = joinPath(manifestDir, 'manifest.json');
		priorEnv = {
			manifest: process.env.DEVSTACK_MANIFEST_PATH,
			stack: process.env.DEVSTACK_STACK,
		};
		process.env.DEVSTACK_MANIFEST_PATH = manifestPath;
	});

	afterEach(() => {
		rmSync(manifestDir, { recursive: true, force: true });
		if (priorEnv.manifest === undefined) delete process.env.DEVSTACK_MANIFEST_PATH;
		else process.env.DEVSTACK_MANIFEST_PATH = priorEnv.manifest;
		if (priorEnv.stack === undefined) delete process.env.DEVSTACK_STACK;
		else process.env.DEVSTACK_STACK = priorEnv.stack;
	});

	describe('webServer()', () => {
		it('resolves dev-server URL from manifest + stamps PLAYWRIGHT=1 + 10s SIGTERM', () => {
			writeFileSync(manifestPath, JSON.stringify(v4Manifest({ devUrl: 'http://dev.test:5175' })));
			const cfg = single(webServer({ endpoint: 'dev-server' }));
			expect(cfg.url).toBe('http://dev.test:5175');
			expect(cfg.command).toBe('pnpm dev');
			expect(cfg.timeout).toBe(120_000);
			expect((cfg.env as { PLAYWRIGHT?: string } | undefined)?.PLAYWRIGHT).toBe('1');
			// gracefulShutdown wiring — fixes the orphan-vite scenario the
			// process-tree commit (41366505) closed.
			expect(cfg.gracefulShutdown).toEqual({ signal: 'SIGTERM', timeout: 10_000 });
		});

		it('resolves sui-rpc URL via the nested services.sui.rpc projection', () => {
			writeFileSync(
				manifestPath,
				JSON.stringify(v4Manifest({ suiRpcUrl: 'http://sui.test:9000' })),
			);
			expect(single(webServer({ endpoint: EndpointName.SUI_RPC })).url).toBe(
				'http://sui.test:9000',
			);
		});

		it('cold-start: with no manifest on disk, falls back to the conventional URL', () => {
			// Don't write the manifest file. The DEVSTACK_MANIFEST_PATH points
			// at it but it doesn't exist, so discoverManifestPath returns
			// undefined and the conventional-URL branch fires.
			process.env.DEVSTACK_STACK = 'main';
			// Conventional: `<service>.<app>.localhost:<port>`. App is the
			// devstack package's own package.json name (we run inside its
			// cwd), service is `dev`, port is 5175.
			expect(single(webServer({ endpoint: 'dev-server' })).url).toMatch(
				/^http:\/\/dev\.[a-zA-Z0-9-]+\.localhost:5175$/,
			);
		});

		it('cold-start fallback honors DEVSTACK_STACK by prefixing the host', () => {
			process.env.DEVSTACK_STACK = 'feature-x';
			// Non-main stack name lands as the leading host label.
			expect(single(webServer({ endpoint: 'dev-server' })).url).toMatch(
				/^http:\/\/feature-x\.dev\.[a-zA-Z0-9-]+\.localhost:5175$/,
			);
		});

		it('throws when the endpoint is not in the manifest', () => {
			writeFileSync(manifestPath, JSON.stringify(v4Manifest({ devUrl: 'http://dev.test:5175' })));
			expect(() => webServer({ endpoint: EndpointName.WALLET_APP })).toThrow(
				/no endpoint 'wallet-app'/,
			);
		});

		it('throws on cold-start when the endpoint has no conventional fallback', () => {
			// Clear DEVSTACK_MANIFEST_PATH so discover walks up from cwd —
			// we're inside packages/devstack so it won't find a real manifest
			// for an unrelated endpoint. The throw comes from the
			// `conventionalUrl === undefined` branch.
			delete process.env.DEVSTACK_MANIFEST_PATH;
			// Pick a name guaranteed not in CONVENTIONAL_ROUTES and unlikely
			// to be in any walk-up manifest.
			expect(() => webServer({ endpoint: 'definitely-not-a-real-endpoint' })).toThrow(
				/no conventional URL fallback/,
			);
		});

		it('respects opts.command / opts.timeout / opts.extend', () => {
			writeFileSync(manifestPath, JSON.stringify(v4Manifest({ devUrl: 'http://dev.test:5175' })));
			const cfg = single(
				webServer({
					endpoint: 'dev-server',
					command: 'npm run dev',
					timeout: 60_000,
					extend: { name: 'my-server' },
				}),
			);
			expect(cfg.command).toBe('npm run dev');
			expect(cfg.timeout).toBe(60_000);
			expect(cfg.name).toBe('my-server');
		});
	});

	describe('baseURL()', () => {
		it('returns the bare URL string for the named endpoint', () => {
			writeFileSync(
				manifestPath,
				JSON.stringify(v4Manifest({ walletUrl: 'http://wallet.test:5180' })),
			);
			expect(baseURL({ endpoint: EndpointName.WALLET_APP })).toBe('http://wallet.test:5180');
		});

		it('mirrors webServer cold-start fallback when no manifest exists', () => {
			process.env.DEVSTACK_STACK = 'main';
			expect(baseURL({ endpoint: 'dev-server' })).toMatch(
				/^http:\/\/dev\.[a-zA-Z0-9-]+\.localhost:5175$/,
			);
		});
	});

	describe('readAppName behavior (via cold-start URL)', () => {
		it('strips @scope/ prefix from package.json name', () => {
			// Stand up a tmpdir as a fake app root with a scoped name and
			// chdir into it. discoverManifestPath has no manifest to find
			// (we drop the env var), so the conventional URL fallback kicks
			// in and reads the local package.json.
			const appDir = mkdtempSync(joinPath(tmpdir(), 'devstack-fake-app-'));
			mkdirSync(joinPath(appDir, 'src'), { recursive: true });
			writeFileSync(joinPath(appDir, 'package.json'), JSON.stringify({ name: '@my-org/my-app' }));
			const priorCwd = process.cwd();
			delete process.env.DEVSTACK_MANIFEST_PATH;
			process.env.DEVSTACK_STACK = 'main';
			try {
				process.chdir(appDir);
				expect(baseURL({ endpoint: 'dev-server' })).toBe('http://dev.my-app.localhost:5175');
			} finally {
				process.chdir(priorCwd);
				rmSync(appDir, { recursive: true, force: true });
			}
		});
	});
});
