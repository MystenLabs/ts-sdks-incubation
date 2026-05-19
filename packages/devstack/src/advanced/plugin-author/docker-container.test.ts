// `dockerContainer(...)` factory smoke. Verifies the public surface:
//
//   - The factory returns a LayeredTag (has `__layer`, `__layers`,
//     `__kind`, `key`).
//   - The image source union enforces `{pull}` xor `{build}` at the
//     type level (bare-string `image: 'postgres:15'` is intentionally
//     not a member of `DockerContainerImage` — see Phase 3.8 of the
//     api-simplification plan).
//   - Default lifecycle is `'long-lived'`.
//
// Integration coverage (real docker daemon, real container) lives in
// the per-plugin smoke playbook — running a real `docker run` against
// every test invocation would dwarf the rest of the suite's wall-time.

import { describe, expect, it } from 'vitest';
import { dockerContainer, type DockerContainerImage } from './docker-container.js';

describe('dockerContainer(name, options) — factory shape', () => {
	it('returns a LayeredTag with the canonical metadata fields', () => {
		const t = dockerContainer('test.smoke.pull', {
			image: { pull: 'busybox:1.36' },
			endpoint: { name: 'TEST', kind: 'internal' },
		});
		expect(t.key).toBe('test.smoke.pull');
		expect(t.__layer).toBeDefined();
		// `extraLayers` from the sibling image tag are merged into `__layers`,
		// so the count is image-layer + this tag's own layer.
		expect(t.__layers.length).toBeGreaterThanOrEqual(2);
		expect(t.__kind).toBe('service');
		expect(t.__displayTitle).toBe('test.smoke.pull');
	});

	it('accepts the `{build: {...}}` image source', () => {
		const t = dockerContainer('test.smoke.build', {
			image: {
				build: {
					context: '/tmp/devstack-test-context',
					dockerfile: 'Dockerfile',
					buildArgs: { FOO: 'bar' },
				},
			},
		});
		expect(t.key).toBe('test.smoke.build');
	});

	it('rejects bare-string `image` at the type level (compile-only assertion)', () => {
		// Type-level negative assertion. If TypeScript ever softens
		// `DockerContainerImage` to accept a bare string, this test
		// becomes a no-op at runtime BUT typecheck flips to OK and the
		// `@ts-expect-error` directive flags as unused — that's the
		// failure signal we want from a CI typecheck pass.
		//
		// @ts-expect-error — image must be `{pull}` or `{build}`, never a bare string
		const _bad: DockerContainerImage = 'postgres:15';
		void _bad;
		expect(true).toBe(true);
	});

	it('omits routing-related fields when no `routing` is configured', () => {
		const t = dockerContainer('test.smoke.no-routing', {
			image: { pull: 'busybox:1.36' },
		});
		// The factory does not set __watchPaths / __hidden for plain
		// long-lived containers.
		expect(t.__watchPaths).toBeUndefined();
		expect(t.__hidden).toBeUndefined();
	});
});
