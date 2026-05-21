// End-to-end boot of `examples/plugin-author-redis-rewrite/` — the
// canonical out-of-tree-plugin example. Demonstrates the
// plugin-author surface: `defineNodePlugin` + `defineTag` +
// `RoutableDecl` for a TCP backend, composed via `defineDevstack`
// like an in-tree plugin.
//
// What this test pins:
//   - The third-party `Redis()` plugin composes inside
//     `defineDevstack(...)` and the substrate accepts it on equal
//     footing with the in-tree plugins.
//   - The plugin reaches `ready` against the supervisor.
//   - The plugin acquires a real Redis container through the
//     ContainerRuntime service and labels it with the owning
//     `(app, stack, plugin, role)` tuple.
//   - The resolved `RedisHandle` carries the expected container ref
//     and in-network endpoint shape.
//
// Prerequisites: docker reachable. Soft-skipped via console warn when
// not (the substrate's container runtime probes docker at boot).

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'plugin-author-redis-rewrite',
	'devstack.config.ts',
);

const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

const REDIS_TEST_CONTAINER = 'plugin-author-redis-main-redis';

const removeRedisTestContainer = (): void => {
	spawnSync('docker', ['rm', '-f', REDIS_TEST_CONTAINER], {
		encoding: 'utf8',
		timeout: 10_000,
	});
};

interface RedisHandleShape {
	readonly containerName: string;
	readonly containerId: string;
	readonly networkAlias: string;
	readonly endpoint: string;
	readonly port: number;
}

describe('plugin-author-redis-rewrite boots end-to-end', () => {
	it('the third-party Redis plugin composes + reaches `ready`', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`plugin-author-redis-boot: skipping — ${docker.detail}`);
			return;
		}

		let redisHandle: RedisHandleShape | null = null;
		removeRedisTestContainer();

		const result = await (async () => {
			try {
				return await runBoot({
					configPath: CONFIG_PATH,
					appName: 'plugin-author-redis',
					stackName: 'main',
					withinScope: (ctx) =>
						Effect.gen(function* () {
							const v = ctx.resolvedValues.get('redis/redis#0');
							if (v !== undefined && typeof v === 'object' && v !== null) {
								redisHandle = v as RedisHandleShape;
							}
							const containers = yield* ctx.containerRuntime
								.inspectByLabels({
									app: ctx.identity.app,
									stack: ctx.identity.stack,
									plugin: 'redis',
									role: 'redis',
								})
								.pipe(Effect.orDie);
							expect(containers).toHaveLength(1);
							const [container] = containers;
							expect(container!.name).toBe(REDIS_TEST_CONTAINER);
							const ping = yield* ctx.containerRuntime
								.exec(container!, ['redis-cli', 'ping'])
								.pipe(Effect.orDie);
							expect(ping.exitCode).toBe(0);
							expect(ping.stdout.trim()).toBe('PONG');
						}),
				});
			} finally {
				removeRedisTestContainer();
			}
		})();

		// Single-plugin expectation. The example composes only
		// `Redis({ route: true })`, so the variadic ordinal is 0.
		const expectedKeys = ['redis/redis#0'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Resolved-handle shape — verifies the third-party plugin's
		// `provides` tag flows through the substrate's resolution
		// path correctly.
		expect(redisHandle, 'redis handle should be resolved').not.toBeNull();
		expect(redisHandle!.containerName).toBe('plugin-author-redis-main-redis');
		expect(redisHandle!.networkAlias).toBe('plugin-author-redis-main-redis');
		expect(redisHandle!.endpoint).toBe('redis://plugin-author-redis-main-redis:6379');
		expect(redisHandle!.port).toBe(6379);
		expect(redisHandle!.containerId).toMatch(/^[a-f0-9]{64}$/);
	}, 180_000);
});
