import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { productionRouterProfile } from '../../../src/orchestrators/runtime-composition.ts';
import { resolveDockerContextId } from '../../../src/orchestrators/router/index.ts';

describe('productionRouterProfile', () => {
	it('is profile-wide and does not vary with runtime roots', () => {
		const runtimeRootA = '/tmp/devstack-runtime-a';
		const runtimeRootB = '/tmp/devstack-runtime-b';
		const opts = { env: { DOCKER_CONTEXT: 'test-context', DOCKER_HOST: undefined } };
		const profileA = productionRouterProfile(opts);
		const profileB = productionRouterProfile(opts);

		expect(profileA).toEqual(profileB);
		expect(profileA.dispatchDir).toContain(`${profileA.id}/dispatch`);
		expect(profileA.dispatchDir).not.toContain('/tmp/devstack-router');
		expect(profileA.dispatchDir).not.toContain(runtimeRootA);
		expect(profileA.dispatchDir).not.toContain(runtimeRootB);
		expect(profileA.containerName).toContain('devstack-router-');
		expect(profileA.networkName).toContain('devstack-router-');
	});

	it('prefers daemon identity over context name when docker exposes it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-router-profile-'));
		try {
			const bin = join(dir, 'docker');
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					'if [ "$1" = "info" ]; then printf "daemon-abc123\\n"; exit 0; fi',
					'if [ "$1" = "context" ]; then printf "context-name\\n"; exit 0; fi',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			expect(
				resolveDockerContextId(
					{ bin },
					{ DOCKER_CONTEXT: 'context-name', DOCKER_HOST: 'tcp://docker.example:2375' },
				),
			).toBe('daemon:daemon-abc123');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
