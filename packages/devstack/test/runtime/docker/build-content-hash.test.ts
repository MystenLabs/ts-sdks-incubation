// Build content-hash projection — never produces a leading `-`.
//
// Architecture rule: the derived docker tag (`devstack-build:<hex>`)
// flows into `docker build -t <ref>`. Docker rejects refs that include
// a leading `-` as "invalid reference format". `Hash.string` returns a
// signed 32-bit int; the projection must coerce to unsigned before hex.
//
// Regression: prior code did `Hash.string(seed).toString(16)` which
// yielded e.g. `-30fd6961` for a negative-signed seed and crashed
// `docker build` at the build-tag site (task #71).

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContentHash } from '../../../src/runtime/docker/service.ts';

describe('buildContentHash — unsigned hex projection', () => {
	it('never emits a leading minus for any context shape', () => {
		// Sweep a wide input space so we cover the negative-int half of
		// the 32-bit space. Hash.string's distribution makes this fast.
		const seeds = [
			'/tmp/foo',
			'/Users/u/code/ts-sdks-incubation/examples/deepbook-trader',
			'/a',
			'',
			'context-path-with-very-long-suffix-' + 'x'.repeat(200),
		];
		for (const path of seeds) {
			for (let i = 0; i < 256; i++) {
				const hash = buildContentHash({
					contextPath: `${path}/${i}`,
					dockerfile: i % 2 === 0 ? 'Dockerfile' : 'Dockerfile.test',
					buildArgs: { iter: String(i), kind: 'mock_usdc' },
				});
				expect(hash, `seed=${path}/${i}`).not.toMatch(/^-/);
				expect(hash, `seed=${path}/${i}`).toMatch(/^[0-9a-f]+$/);
			}
		}
	});

	it('is stable across buildArgs key insertion order', () => {
		const a = buildContentHash({
			contextPath: '/tmp/ctx',
			buildArgs: { a: '1', b: '2' },
		});
		const b = buildContentHash({
			contextPath: '/tmp/ctx',
			buildArgs: { b: '2', a: '1' },
		});
		expect(a).toBe(b);
	});

	it('differs when contextPath differs', () => {
		const a = buildContentHash({ contextPath: '/tmp/a' });
		const b = buildContentHash({ contextPath: '/tmp/b' });
		expect(a).not.toBe(b);
	});

	it('differs when platform differs', () => {
		const native = buildContentHash({ contextPath: '/tmp/ctx' });
		const amd64 = buildContentHash({ contextPath: '/tmp/ctx', platform: 'linux/amd64' });
		expect(native).not.toBe(amd64);
	});

	it('differs when a build-context file changes', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-build-context-'));
		try {
			const entrypoint = join(dir, 'entrypoint.sh');
			writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\nCOPY entrypoint.sh /entrypoint.sh\n');
			writeFileSync(entrypoint, 'echo first\n');
			const first = buildContentHash({ contextPath: dir, dockerfile: 'Dockerfile' });

			writeFileSync(entrypoint, 'echo second\n');
			const second = buildContentHash({ contextPath: dir, dockerfile: 'Dockerfile' });

			expect(first).not.toBe(second);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('can fingerprint only the files an image copies from a shared context', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-build-context-scoped-'));
		try {
			const suiDir = join(dir, 'sui');
			const walrusDir = join(dir, 'walrus');
			const sharedDir = join(dir, '_shared');
			writeFileSync(join(dir, 'marker'), 'context root\n');
			mkdirSync(suiDir, { recursive: true });
			mkdirSync(walrusDir, { recursive: true });
			mkdirSync(sharedDir, { recursive: true });
			writeFileSync(
				join(suiDir, 'Dockerfile'),
				'FROM scratch\nCOPY sui/entrypoint.sh /entrypoint.sh\n',
			);
			writeFileSync(join(suiDir, 'entrypoint.sh'), 'echo sui\n');
			writeFileSync(join(sharedDir, 'signal-forward.sh'), 'echo shared\n');
			writeFileSync(join(walrusDir, 'run-walrus.sh'), 'echo walrus first\n');

			const build = {
				contextPath: dir,
				dockerfile: 'sui/Dockerfile',
				fingerprintPaths: ['sui/Dockerfile', 'sui/entrypoint.sh', '_shared/signal-forward.sh'],
			};
			const first = buildContentHash(build);

			writeFileSync(join(walrusDir, 'run-walrus.sh'), 'echo walrus second\n');
			expect(buildContentHash(build)).toBe(first);

			writeFileSync(join(sharedDir, 'signal-forward.sh'), 'echo shared second\n');
			expect(buildContentHash(build)).not.toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
