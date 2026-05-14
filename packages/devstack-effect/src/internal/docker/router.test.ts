// Pure-helper tests for the router slice:
//   - label assembly (`routerLabelStrings`)
//   - file-provider YAML body shape (`renderFileProvider`)
//   - file-provider write/remove lifecycle (`writeFileProvider` +
//     `removeFileProvider`) against a temp `DEVSTACK_ROUTER_DYNAMIC_DIR`
//
// The full `ensureRouter` boot flow is covered by the integration
// suite (it shells out to docker, which the unit tests don't carry).

import { Effect } from 'effect';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { it as itEffect } from '@effect/vitest';
import {
	renderFileProvider,
	removeFileProvider,
	routerLabelStrings,
	writeFileProvider,
} from './router.js';

describe('routerLabelStrings', () => {
	it('stamps the canonical 5-label set for a single backend', () => {
		const labels = routerLabelStrings({
			id: 'arena-main-sui-rpc',
			hostname: 'sui.arena.localhost',
			entrypoint: 'sui-rpc',
			servicePort: 9000,
		});
		expect(labels).toEqual([
			'traefik.enable=true',
			'traefik.docker.network=devstack-router',
			'traefik.http.routers.arena-main-sui-rpc.rule=Host(`sui.arena.localhost`)',
			'traefik.http.routers.arena-main-sui-rpc.entrypoints=sui-rpc',
			'traefik.http.services.arena-main-sui-rpc.loadbalancer.server.port=9000',
		]);
	});

	it('uses backticks around the hostname (traefik requires them on Host rules)', () => {
		const labels = routerLabelStrings({
			id: 'a-b-c',
			hostname: 'host.localhost',
			entrypoint: 'wallet',
			servicePort: 5180,
		});
		expect(labels[2]).toBe('traefik.http.routers.a-b-c.rule=Host(`host.localhost`)');
	});
});

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
