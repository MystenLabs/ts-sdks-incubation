// Regression test for the manifest-path consolidation.
//
// This test asserts every integration that resolves a manifest path
// converges on the supervisor-written path given the same `cwd` + `stack`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { loadStackContext } from '../../src/build-integrations/vitest/stack-context.ts';
import { discoverManifestPath as playwrightDiscover } from '../../src/build-integrations/playwright/stack-context.ts';
import {
	discoverManifestPath as runtimeDiscover,
	CONSUMER_MANIFEST_VERSION,
} from '../../src/build-integrations/runtime/index.ts';
import { withTempRootSync } from '../helpers/with-temp-root.ts';

const writeManifest = (root: string, stack: string, body: Record<string, unknown>): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'manifest.json');
	writeFileSync(path, JSON.stringify(body));
	return path;
};

describe('manifest-path parity across build integrations', () => {
	it('all resolvers point at the same supervisor-written path', () =>
		withTempRootSync('devstack-parity', (root) => {
			// Plant a stack-scoped manifest at the path the supervisor
			// actually writes (cwd-walkup, `.devstack/stacks/<stack>/`).
			const supervisorPath = writeManifest(root, 'main', {
				identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
				manifestVersion: CONSUMER_MANIFEST_VERSION,
				services: {},
				endpoints: {},
				extras: {},
			});
			// Runtime / canonical resolver.
			const runtimeOut = runtimeDiscover({ cwd: root, env: {} });
			expect(runtimeOut).toBe(supervisorPath);

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
		}));
});
