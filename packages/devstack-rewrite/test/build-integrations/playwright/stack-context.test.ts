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
		app: {
			url: 'http://main.app.localhost:8000',
			displayUrl: 'http://main.app.localhost:8000',
			wireProtocol: 'http',
			pluginKey: 'app',
			endpointKey: 'app',
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
		expect(ctx.endpointMaybe('not-there')).toBeNull();
	});

	it('endpoint() throws PlaywrightEndpointNotFoundError for missing keys', () => {
		const stateDir = join(workdir, '.devstack');
		mkdirSync(join(stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(
			join(stateDir, 'stacks', 'main', 'manifest.json'),
			JSON.stringify(sampleEnvelope()),
		);
		const ctx = readStackContext({ cwd: workdir, env: {} });
		expect(() => ctx.endpoint('missing')).toThrow(PlaywrightEndpointNotFoundError);
	});
});

describe('conventionalUrlFor', () => {
	it('returns a known endpoint pattern URL when port is given', () => {
		const url = conventionalUrlFor('sui-rpc', { stack: 'main', port: 80 });
		expect(url).toBe('http://main.sui-rpc.localhost:80');
	});

	it('returns null for unknown endpoints', () => {
		expect(conventionalUrlFor('unknown-thing', { port: 80 })).toBeNull();
	});

	it('returns null when no port is resolvable', () => {
		expect(conventionalUrlFor('sui-rpc', {})).toBeNull();
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
		expect(resolved.url).toBe('http://main.app.localhost:8000');
	});

	it('falls back to conventional URL when no manifest is present', () => {
		const resolved = resolveEndpointUrl('app', {
			cwd: workdir,
			env: {},
			port: 80,
		});
		expect(resolved.source).toBe('conventional');
		expect(resolved.url).toBe('http://main.app.localhost:80');
	});
});
