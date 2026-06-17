// Playwright `globalSetup` — through-surface tests.
//
// The default export BOOTS a stack via `runStack` (covered by the Docker e2e
// suites, not here — it needs a live supervisor). These unit tests drive the
// READ-ONLY path (`reuse`/explicit `manifestPath`): manifest discovery, the
// single-stack fallback, the `require*` fast-fails, and the fixture stash —
// all without a live supervisor or browser.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGlobalSetup } from '../../../src/build-integrations/playwright/global-setup.ts';
import { PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY } from '../../../src/build-integrations/runtime/playwright-stack-context-slot.ts';
import { CURRENT_MANIFEST_VERSION } from '../../../src/substrate/runtime/manifest/manifest.ts';
import { withTempRootAsync } from '../../helpers/with-temp-root.ts';

const sampleEnvelope = (overrides?: { endpoints?: Record<string, unknown> }) => ({
	identity: { app: 'sample-app', stack: 'main', network: 'localnet' },
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

/** Write a manifest into a `.devstack/stacks/<stack>/manifest.json` layout
 *  under `root` and return the manifest path. */
const writeStack = (root: string, stack = 'main', envelope: unknown = sampleEnvelope()): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, 'manifest.json');
	writeFileSync(manifestPath, JSON.stringify(envelope));
	return manifestPath;
};

describe('buildGlobalSetup — read-only path (explicit manifestPath)', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('reads the manifest and stashes the fixture (no boot)', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const manifestPath = writeStack(root);
			const teardown = await buildGlobalSetup({ manifestPath })();
			expect(typeof teardown).toBe('function');

			const fixture = globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
			expect(fixture?.manifestPath).toBe(manifestPath);
			expect(fixture?.endpoints.app).toBe('http://main.app.localhost:8000');
		});
	});

	it('requireNonEmptyEndpoints throws when the manifest has zero endpoints', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const manifestPath = writeStack(root, 'main', sampleEnvelope({ endpoints: {} }));
			const setup = buildGlobalSetup({ manifestPath, requireNonEmptyEndpoints: true });
			await expect(setup()).rejects.toThrow(/has no endpoints/u);
		});
	});

	it('requireEndpoints throws listing the missing endpoint names', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const manifestPath = writeStack(root);
			const setup = buildGlobalSetup({ manifestPath, requireEndpoints: ['wallet', 'sui-faucet'] });
			await expect(setup()).rejects.toThrow(/missing required endpoints: wallet, sui-faucet/u);
		});
	});

	it('requireEndpoints passes when the named endpoint (via alias) is present', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const manifestPath = writeStack(root);
			// `'app'` aliases to the canonical `'dev'` endpoint present in the
			// sample manifest.
			const setup = buildGlobalSetup({ manifestPath, requireEndpoints: ['app'] });
			await expect(setup()).resolves.toBeTypeOf('function');
		});
	});

	it('preloadContext:false leaves the globalThis slot untouched', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const manifestPath = writeStack(root);
			const setup = buildGlobalSetup({ manifestPath, preloadContext: false });
			await setup();
			expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]).toBeUndefined();
		});
	});
});

describe('buildGlobalSetup — read-only single-stack manifest fallback', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('infers the lone stack when no explicit path/stack is given', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			// Single stack named something OTHER than the default `main`, so the
			// plain discover walk-up (which targets `main`) misses and the
			// single-stack fallback in `readContextForSetup` kicks in. `reuse`
			// takes the read-only path so no boot is attempted.
			const manifestPath = writeStack(root, 'only-one');
			const setup = buildGlobalSetup({ cwd: root, env: {}, reuse: true });
			await setup();
			expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]?.manifestPath).toBe(manifestPath);
		});
	});

	it('does NOT apply the single-stack fallback when a stack was explicitly requested', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			writeStack(root, 'only-one');
			const setup = buildGlobalSetup({ cwd: root, env: {}, stack: 'main', reuse: true });
			await expect(setup()).rejects.toThrow();
		});
	});

	it('does NOT apply the single-stack fallback when multiple stacks are ambiguous', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			writeStack(root, 'stack-a');
			writeStack(root, 'stack-b');
			const setup = buildGlobalSetup({ cwd: root, env: {}, reuse: true });
			await expect(setup()).rejects.toThrow();
		});
	});
});
