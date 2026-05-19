// Example out-of-tree plugin: wrap a Redis Docker container as a
// devstack service using the `/advanced/plugin-author` surface.
//
// Acts as living documentation for the `dockerContainer(...)` primitive.
// What it demonstrates:
//
//   - Image source: `{pull: 'redis:7-alpine'}` — the canonical "pull a
//     registry image" shape.
//   - Ready probe: TCP on the container's 6379 port so the tag doesn't
//     resolve until the Redis server is accepting connections.
//   - Routing: declare a custom `defineEntrypoint(...)` for redis at
//     module load time, then point `dockerContainer`'s `routing` at it
//     so the container surfaces as `redis.<app>.localhost` via the
//     shared traefik router.
//   - Endpoint publish: `endpoint: { name: 'REDIS', kind: 'internal' }`
//     so the manifest / codegen / TUI see the resolved URL.
//   - Tag shape: the factory returns a `LayeredTag<'redis', RedisHandle>`
//     downstream consumers can `yield*` to get the connection URL.
//
// No in-tree devstack code references this file; it lives in the
// example to exercise the plugin-author surface from an out-of-tree
// callsite the same way a third-party plugin would.

import {
	defineEntrypoint,
	dockerContainer,
	makeService,
	type DockerContainerHandle,
	type LayeredTag,
} from '@mysten-incubation/devstack/advanced';

// Register the entrypoint at module load time so it's present before
// the supervisor boots traefik. Picked 16379 to stay clear of in-tree
// ports (9000-9999, 5173-5180, 50051). The default protocol is the
// implicit `'http'` — Redis isn't HTTP, but the traefik route here is
// only used for the dashboard hostname; in-cluster consumers dial the
// container's docker DNS alias on the upstream port directly.
defineEntrypoint({ name: 'redis', port: 16379 });

export interface RedisOptions {
	/** Container memory cap. Defaults to 64MB — Redis is lean. */
	readonly maxMemory?: string;
	/** Override the container name surfaced in `docker ps`. */
	readonly name?: string;
}

/**
 * Bring up a Redis container as a devstack service.
 *
 * Returns a `LayeredTag<Name, DockerContainerHandle>` — `yield* Redis`
 * in any downstream tag's build to get the resolved handle (URL, image
 * id, container id).
 *
 * @example
 * ```ts
 * import { devstack } from '@mysten-incubation/devstack';
 * import { Redis } from './redis-plugin.js';
 *
 * const redis = Redis();
 * export default devstack(redis);
 * ```
 */
export const Redis = (
	opts: RedisOptions = {},
): LayeredTag<'redis', DockerContainerHandle, any, any> => {
	const name = (opts.name ?? 'redis') as 'redis';
	const container = dockerContainer(name, {
		image: { pull: 'redis:7-alpine' },
		args: [
			'redis-server',
			'--save',
			'',
			'--appendonly',
			'no',
			'--maxmemory',
			opts.maxMemory ?? '64mb',
			'--maxmemory-policy',
			'allkeys-lru',
		],
		// `routing` exposes the container through the shared traefik
		// router so a host-side curl / dashboard lands on
		// `redis.<app>.localhost`. In-cluster consumers (downstream
		// plugins yielding this tag) still dial the upstream port via
		// docker DNS, so the routing is purely for host-side
		// observability — Redis itself doesn't speak HTTP.
		routing: {
			entrypoint: 'redis',
			servicePort: 6379,
			protocol: 'http',
		},
		// TCP ready-probe gates the tag's resolution until Redis is
		// accepting connections on 6379. Without this the tag resolves
		// as soon as `docker run` returns, which races
		// `redis-server`'s `bind()`.
		ready: { kind: 'tcp', port: 6379, timeoutMs: 30_000 },
		// Publish into the EndpointRegistry so the manifest / codegen
		// / TUI surface the resolved URL. Picked `'internal'` for the
		// kind since Redis is dialed by sibling services, not by the
		// browser.
		endpoint: { name: 'REDIS', kind: 'internal' },
		stopGraceSeconds: 5,
	});
	// Stamp the plugin attribution via the canonical `makeService` HOF.
	// Out-of-tree plugins reach for `makeService(pluginName, kind, impl)`
	// instead of hand-rolling `Object.assign(impl, { __kind, __pluginName })`
	// — same runtime shape, but the helper documents intent and stays
	// in lockstep with the in-tree factories (Sui, Wallet, …) the user
	// already imports from the main barrel. `pluginName: 'redis'` drives
	// the TUI's `[redis]` chip + a stable section color the user can
	// learn ("blue = redis").
	return makeService('redis', 'service', container) as LayeredTag<
		'redis',
		DockerContainerHandle,
		any,
		any
	>;
};
