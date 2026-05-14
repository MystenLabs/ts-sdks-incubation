// Pure-helper tests for the router slice:
//   - file-provider YAML body shape (`renderFileProvider`)
//   - file-provider write/remove lifecycle (`writeFileProvider` +
//     `removeFileProvider`) against a temp `DEVSTACK_ROUTER_DYNAMIC_DIR`
//
// The full `ensureRouter` boot flow is covered by the integration
// suite (it shells out to docker, which the unit tests don't carry).
//
// NOTE: an earlier revision tested `routerLabelStrings` here, asserting
// the docker-provider label set we used to stamp on each container.
// That export is gone — traefik is now file-provider-only (see the
// architecture comment at the top of `router.ts`). Docker.run writes a
// YAML per RouterLabel after `docker network connect`, dodging the
// docker-provider race where the per-stack IP gets captured before the
// router-network IP is settled.

import { Effect } from 'effect';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { it as itEffect } from '@effect/vitest';
import {
	listRegisteredHostnames,
	renderFileProvider,
	removeFileProvider,
	writeFileProvider,
} from './router.js';

describe('renderFileProvider', () => {
	it('renders the canonical YAML shape for a host-process backend', () => {
		const yaml = renderFileProvider({
			id: 'arena-main-vite',
			hostname: 'dev.arena.localhost',
			entrypoint: 'vite',
			upstreamUrl: 'http://host.docker.internal:5175',
		});
		expect(yaml).toContain('http:');
		expect(yaml).toContain('  routers:');
		expect(yaml).toContain('    arena-main-vite:');
		expect(yaml).toContain('      rule: "Host(`dev.arena.localhost`)"');
		expect(yaml).toContain('      entrypoints: ["vite"]');
		expect(yaml).toContain('      service: arena-main-vite');
		expect(yaml).toContain('  services:');
		expect(yaml).toContain('          - url: "http://host.docker.internal:5175"');
	});
});

describe('file-provider lifecycle', () => {
	itEffect.effect('write then remove leaves the dir empty', () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = dir;
			try {
				const path = yield* writeFileProvider({
					id: 'arena-main-wallet',
					hostname: 'wallet.arena.localhost',
					entrypoint: 'wallet',
					upstreamUrl: 'http://host.docker.internal:5180',
				});
				expect(existsSync(path)).toBe(true);
				const body = readFileSync(path, 'utf8');
				expect(body).toContain('arena-main-wallet');
				expect(body).toContain('wallet.arena.localhost');
				yield* removeFileProvider('arena-main-wallet');
				expect(existsSync(path)).toBe(false);
			} finally {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);

	itEffect.effect('remove on a missing file is a silent no-op', () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = dir;
			try {
				yield* removeFileProvider('never-existed');
			} finally {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);
});

// -----------------------------------------------------------------------------
// `listRegisteredHostnames` — extract Host(`...`) values from every
// file-provider YAML in `routerDynamicDir()`. Drives the `--add-host`
// add-on for containers that opt into routed-hostname DNS.
// -----------------------------------------------------------------------------

describe('listRegisteredHostnames', () => {
	itEffect.effect('returns each YAML\'s Host(`...`) value; ignores non-yml files', () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = dir;
			try {
				// Two real file-provider YAMLs alongside a stray non-yml
				// file that should be ignored.
				yield* writeFileProvider({
					id: 'arena-main-sui-rpc',
					hostname: 'sui.arena.localhost',
					entrypoint: 'sui-rpc',
					upstreamUrl: 'http://172.21.0.3:9000',
				});
				yield* writeFileProvider({
					id: 'arena-main-walrus-node-0',
					hostname: 'walrus-node-0.arena.localhost',
					entrypoint: 'walrus',
					upstreamUrl: 'http://172.21.0.4:9185',
				});
				writeFileSync(join(dir, 'README.txt'), 'not a yaml', 'utf8');

				const hostnames = yield* listRegisteredHostnames();
				expect([...hostnames].sort()).toEqual([
					'sui.arena.localhost',
					'walrus-node-0.arena.localhost',
				]);
			} finally {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);

	itEffect.effect('returns an empty array when the dir does not exist', () =>
		Effect.gen(function* () {
			const missingDir = join(tmpdir(), 'devstack-router-test-missing-' + Date.now());
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = missingDir;
			try {
				const hostnames = yield* listRegisteredHostnames();
				expect(hostnames).toEqual([]);
			} finally {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
			}
		}),
	);

	itEffect.effect('skips YAMLs without a recognizable Host(`...`) rule', () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = dir;
			try {
				writeFileSync(join(dir, 'bogus.yml'), 'http:\n  routers: {}\n', 'utf8');
				yield* writeFileProvider({
					id: 'arena-main-vite',
					hostname: 'dev.arena.localhost',
					entrypoint: 'vite',
					upstreamUrl: 'http://host.docker.internal:5175',
				});
				const hostnames = yield* listRegisteredHostnames();
				expect(hostnames).toEqual(['dev.arena.localhost']);
			} finally {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);
});
