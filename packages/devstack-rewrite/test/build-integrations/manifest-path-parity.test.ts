// Regression test for the manifest-path consolidation.
//
// Before the consolidation, the vite preset's `discover.ts` resolved
// to `~/.devstack/<app>/<stack>/manifest.json` (HOME-rooted), while
// vitest, playwright, and the canonical `runtime/` resolver used
// `<cwd>/.devstack/stacks/<stack>/manifest.json` (cwd-walkup,
// stack-scoped). The vite preset therefore never found the
// supervisor's manifest and ran in permanent cold-start.
//
// This test asserts every integration that resolves a manifest path
// converges on the same path given the same `cwd` + `stack`.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { discoverIdentity } from '../../src/build-integrations/vite/discover.ts';
import { loadStackContext } from '../../src/build-integrations/vitest/stack-context.ts';
import { discoverManifestPath as playwrightDiscover } from '../../src/build-integrations/playwright/stack-context.ts';
import {
	discoverManifestPath as runtimeDiscover,
	CONSUMER_MANIFEST_VERSION,
} from '../../src/build-integrations/runtime/index.ts';

const writeManifest = (root: string, stack: string, body: Record<string, unknown>): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'manifest.json');
	writeFileSync(path, JSON.stringify(body));
	return path;
};

describe('manifest-path parity across the 4 build integrations', () => {
	it('all four resolvers point at the same supervisor-written path', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-parity-'));
		// Plant a stack-scoped manifest at the path the supervisor
		// actually writes (cwd-walkup, `.devstack/stacks/<stack>/`).
		const supervisorPath = writeManifest(root, 'main', {
			identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
			manifestVersion: CONSUMER_MANIFEST_VERSION,
			services: {},
			endpoints: {},
			extras: {},
		});
		// A package.json at root so the vite identity resolver can
		// derive the app name without an explicit option.
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));

		// Runtime / canonical resolver.
		const runtimeOut = runtimeDiscover({ cwd: root, env: {} });
		expect(runtimeOut).toBe(supervisorPath);

		// Vite preset.
		const viteIdent = discoverIdentity({ cwd: root });
		expect(viteIdent.manifestPath).toBe(supervisorPath);

		// Vitest preset.
		const vitestCtx = loadStackContext({
			cwd: root,
			env: {},
			stack: 'main',
		});
		expect(vitestCtx?.manifestPath).toBe(supervisorPath);

		// Playwright preset.
		const playwrightOut = playwrightDiscover({ cwd: root, env: {} });
		expect(playwrightOut?.path).toBe(supervisorPath);
	});
});
