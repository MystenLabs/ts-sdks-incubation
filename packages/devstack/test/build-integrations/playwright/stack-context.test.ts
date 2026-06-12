// Stack-context discovery + sync read.
//
// Architecture invariants verified here:
//   - walk-up finds a stack-scoped manifest under
//     `.devstack/stacks/<stack>/manifest.json`
//   - env override (`DEVSTACK_MANIFEST_PATH`) wins over walk-up
//   - missing-manifest + missing-conventional → typed
//     `PlaywrightManifestDiscoveryError`
//   - present manifest with absent endpoint → typed
//     `PlaywrightEndpointNotFoundError`
//   - cold-start fallback returns a conventional URL for known
//     endpoints when no manifest is present

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	PlaywrightEndpointNotFoundError,
	PlaywrightManifestDiscoveryError,
	PlaywrightManifestShapeError,
} from '../../../src/build-integrations/playwright/errors.ts';
import {
	conventionalUrlFor,
	discoverManifestPath,
	readStackContext,
	resolveEndpointUrl,
} from '../../../src/build-integrations/playwright/stack-context.ts';
import { CURRENT_MANIFEST_VERSION } from '../../../src/substrate/runtime/manifest/manifest.ts';

const sampleEnvelope = (overrides?: { endpoints?: Record<string, unknown> }) => ({
	identity: { app: 'sample-app', stack: 'main', chain: 'localnet' },
	manifestVersion: CURRENT_MANIFEST_VERSION,
	services: {},
	endpoints: overrides?.endpoints ?? {
		'host-service/app#5:dev': {
			name: 'dev',
			url: 'http://main.app.localhost:8000',
			displayUrl: 'http://main.app.localhost:8000',
			wireProtocol: 'http',
			pluginKey: 'host-service/app#5',
			endpointKey: 'host-service/app#5:dev',
		},
	},
	extras: {},
});

describe('discoverManifestPath', () => {
	let workdir: string;
	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), 'pw-stack-ctx-'));
	});
	afterEach(() => rmSync(workdir, { recursive: true, force: true }));

	it('walks up from cwd to find a stack-scoped manifest', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		const path = join(stateDir, 'stacks', 'main', 'manifest.json');
		writeFileSync(path, JSON.stringify(sampleEnvelope()));

		const found = discoverManifestPath({ cwd: workdir, env: {} });
		expect(found?.path).toBe(path);
	});

	it('honors the explicit DEVSTACK_MANIFEST_PATH override', () => {
		const explicit = join(workdir, 'custom-manifest.json');
		writeFileSync(explicit, JSON.stringify(sampleEnvelope()));
		const found = discoverManifestPath({
			cwd: workdir,
			env: { DEVSTACK_MANIFEST_PATH: explicit },
		});
		expect(found?.path).toBe(explicit);
	});

	it('returns null when no manifest is reachable', () => {
		const found = discoverManifestPath({ cwd: workdir, env: {} });
		expect(found).toBeNull();
	});

	it('infers the stack from the nearest package.json name when DEVSTACK_STACK is unset', () => {
		// Aligned with the CLI's `resolveStackName`: a bare app's stack is
		// named after the package, so the playwright surface must discover
		// it without env wiring.
		writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: '@scope/smoke-app' }));
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'smoke-app'), { recursive: true });
		const path = join(stateDir, 'stacks', 'smoke-app', 'manifest.json');
		writeFileSync(path, JSON.stringify(sampleEnvelope()));

		const found = discoverManifestPath({ cwd: workdir, env: {} });
		expect(found?.path).toBe(path);
	});
});

describe('readStackContext', () => {
	let workdir: string;
	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), 'pw-stack-ctx-'));
	});
	afterEach(() => rmSync(workdir, { recursive: true, force: true }));

	it('throws PlaywrightManifestDiscoveryError when nothing is on disk', () => {
		expect(() => readStackContext({ cwd: workdir, env: {} })).toThrow(
			PlaywrightManifestDiscoveryError,
		);
	});

	it('throws PlaywrightManifestShapeError on malformed JSON', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(join(stateDir, 'stacks', 'main', 'manifest.json'), 'not-json');

		expect(() => readStackContext({ cwd: workdir, env: {} })).toThrow(PlaywrightManifestShapeError);
	});

	it('decodes a well-formed manifest and exposes the endpoint accessors', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(
			join(stateDir, 'stacks', 'main', 'manifest.json'),
			JSON.stringify(sampleEnvelope()),
		);

		const ctx = readStackContext({ cwd: workdir, env: {} });
		expect(ctx.endpoint('app')).toBe('http://main.app.localhost:8000');
		expect(ctx.endpoint('dev')).toBe('http://main.app.localhost:8000');
		expect(ctx.endpointNames).toEqual(['dev']);
		expect(ctx.manifestEndpointKeys).toEqual(['host-service/app#5:dev']);
		expect(ctx.endpointMaybe('not-there')).toBeNull();
	});

	it('endpoint() throws PlaywrightEndpointNotFoundError with endpoint names and raw keys', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(
			join(stateDir, 'stacks', 'main', 'manifest.json'),
			JSON.stringify(sampleEnvelope()),
		);
		const ctx = readStackContext({ cwd: workdir, env: {} });
		try {
			ctx.endpoint('missing');
			expect.fail('expected endpoint lookup to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PlaywrightEndpointNotFoundError);
			const err = error as PlaywrightEndpointNotFoundError;
			expect(err.available).toEqual(['dev']);
			expect(err.manifestKeys).toEqual(['host-service/app#5:dev']);
			expect(err.message).toContain('resolved endpoint name `missing`');
		}
	});
});

describe('conventionalUrlFor', () => {
	it('returns a known endpoint pattern URL when port is given', () => {
		const url = conventionalUrlFor('sui-rpc', { stack: 'main', port: 80, app: 'wallet' });
		expect(url).toBe('http://sui-rpc.wallet.localhost:80');
	});

	it('maps the app endpoint to the shared dev-server conventional route', () => {
		const url = conventionalUrlFor('app', { stack: 'main', port: 80, app: 'wallet' });
		expect(url).toBe('http://dev.wallet.localhost:80');
	});

	it('uses the conventional dev-server port when resolving app cold-start URLs', () => {
		const prior = process.env.DEVSTACK_ROUTER_PORT;
		delete process.env.DEVSTACK_ROUTER_PORT;
		try {
			const url = conventionalUrlFor('app', { stack: 'main', app: 'wallet' });
			expect(url).toBe('http://dev.wallet.localhost:5175');
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_ROUTER_PORT;
			else process.env.DEVSTACK_ROUTER_PORT = prior;
		}
	});

	it('honors an injected router port env when resolving conventional URLs', () => {
		const url = conventionalUrlFor('app', {
			stack: 'main',
			app: 'wallet',
			env: { DEVSTACK_ROUTER_PORT: '8181' },
		});
		expect(url).toBe('http://dev.wallet.localhost:8181');
	});

	it('returns null for unknown endpoints', () => {
		expect(conventionalUrlFor('unknown-thing', { port: 80 })).toBeNull();
	});

	it('uses DEFAULT_ROUTER_ENTRYPOINT_PORT for every built-in endpoint when no port is specified', () => {
		// Post backlog #30 lift: the conventional route table is owned by
		// `runtime/conventional-routes.ts` and the default port applies
		// uniformly to every built-in endpoint (the router's single
		// Traefik entrypoint dispatches by Host header).
		const url = conventionalUrlFor('sui-rpc', { stack: 'main', app: 'wallet' });
		expect(url).toBe('http://sui-rpc.wallet.localhost:5175');
	});
});

describe('resolveEndpointUrl', () => {
	let workdir: string;
	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), 'pw-stack-ctx-'));
	});
	afterEach(() => rmSync(workdir, { recursive: true, force: true }));

	it('returns source=manifest when the manifest has the endpoint', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(
			join(stateDir, 'stacks', 'main', 'manifest.json'),
			JSON.stringify(sampleEnvelope()),
		);
		const resolved = resolveEndpointUrl('app', { cwd: workdir, env: {} });
		expect(resolved.source).toBe('manifest');
		expect(resolved.endpointName).toBe('dev');
		expect(resolved.url).toBe('http://main.app.localhost:8000');
	});

	it('falls back to conventional URL when no manifest is present', () => {
		const prior = process.env.DEVSTACK_ROUTER_PORT;
		delete process.env.DEVSTACK_ROUTER_PORT;
		try {
			const resolved = resolveEndpointUrl('app', {
				cwd: workdir,
				env: {},
			});
			expect(resolved.source).toBe('conventional');
			expect(resolved.url).toMatch(/^http:\/\/dev\.pw-stack-ctx-.*\.localhost:5175$/);
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_ROUTER_PORT;
			else process.env.DEVSTACK_ROUTER_PORT = prior;
		}
	});
});
