// Example out-of-tree plugin: wrap a Redis Docker container as a
// devstack service using the rewrite's plugin-authoring surface.
//
// Living documentation for the third-party plugin pattern. The plugin
// author uses the SAME imports an app author uses — `defineNodePlugin`,
// `defineTag`, `capabilities`, `RoutableDecl` all come from the single
// root barrel (api-surface-design.md P2: plugin-author surface = user
// surface).
//
// PARALLEL-STACK NOTE. The TCP entrypoint binds ONE host port and
// dispatches by entrypoint (TCP has no virtual hosts), so exactly one
// stack on the host may set `route: true` at a time.

import { Duration, Effect, Schedule } from 'effect';

import {
	capabilities,
	ContainerRuntimeService,
	defineNodePlugin,
	defineTag,
	IdentityContext,
	type ContainerHandle,
	type ContainerRuntime,
	type RoutableDecl,
} from '@mysten-incubation/devstack-rewrite';

export interface RedisOptions {
	/** Container memory cap. Defaults to 64MB — Redis is lean. */
	readonly maxMemory?: string;
	/** Override the container name surfaced in `docker ps`. Folds into
	 *  the per-instance tag id. */
	readonly name?: string;
	/** When true, contribute a TCP `RoutableDecl` so the shared Traefik
	 *  router fronts this redis container on the `redis-tcp` entrypoint
	 *  (host port 6379). One stack on the host may set this at a time
	 *  (collision detection rejects the second). Default `false`. */
	readonly route?: boolean;
	/** Redis image tag. Defaults to `redis:7-alpine`. */
	readonly image?: string;
	/** Bounded readiness wait. Defaults to 30s. */
	readonly readyTimeoutMs?: number;
}

/** Resolved handle. `endpoint` is the in-container dial string for
 *  consumers that intentionally share a Docker network with Redis.
 *  Host-side access is exposed through the optional TCP router route. */
export interface RedisHandle {
	readonly containerName: string;
	readonly containerId: string;
	readonly networkAlias: string;
	readonly endpoint: string;
	readonly port: number;
}

const makeRedisTag = <Name extends string>(name: Name) =>
	defineTag<`redis/${Name}`, RedisHandle>(`redis/${name}` as `redis/${Name}`, 'redis');

export const REDIS_TCP_ENDPOINT_NAME = 'redis-tcp' as const;
const REDIS_PORT = 6379;
const DEFAULT_REDIS_IMAGE = 'redis:7-alpine';
const DEFAULT_READY_TIMEOUT_MS = 30_000;

type RedisPhase = 'container-start' | 'ready';

interface RedisPluginError {
	readonly _tag: 'RedisPluginError';
	readonly phase: RedisPhase;
	readonly name: string;
	readonly message: string;
	readonly cause?: unknown;
}

const redisError = (
	phase: RedisPhase,
	name: string,
	message: string,
	cause?: unknown,
): RedisPluginError => ({
	_tag: 'RedisPluginError',
	phase,
	name,
	message,
	...(cause === undefined ? {} : { cause }),
});

const sanitizeDockerSegment = (value: string): string =>
	value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'redis';

const redisImageRef = (tag: string) => ({ digest: tag, tag });

const awaitRedisReady = (
	runtime: ContainerRuntime,
	handle: ContainerHandle,
	name: string,
	timeoutMs: number,
): Effect.Effect<void, RedisPluginError> =>
	runtime.exec(handle, ['redis-cli', 'ping']).pipe(
		Effect.flatMap((res) =>
			res.exitCode === 0 && res.stdout.trim() === 'PONG'
				? Effect.void
				: Effect.fail(
						redisError(
							'ready',
							name,
							`redis '${name}' is not ready yet: exit=${res.exitCode}, stderr=${res.stderr}`,
						),
					),
		),
		Effect.catch((err) =>
			err._tag === 'RedisPluginError'
				? Effect.fail(err)
				: Effect.fail(
						redisError(
							'ready',
							name,
							`redis '${name}' ready probe failed: ${err.reason}: ${err.detail}`,
							err,
						),
					),
		),
		Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)) }),
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.fail(
					redisError('ready', name, `redis '${name}' did not become ready within ${timeoutMs}ms`),
				),
		}),
	);

const makeRedisRoutable = (parts: {
	readonly app: string;
	readonly stack: string;
	readonly name: string;
	readonly containerName: string;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: REDIS_TCP_ENDPOINT_NAME,
	dispatchId: {
		compositeKey: `redis.${parts.app}.${parts.stack}.${parts.name}`,
		role: parts.name,
	},
	upstream: {
		type: 'container',
		containerName: parts.containerName,
		containerPort: REDIS_PORT,
	},
	wireProtocol: 'tcp',
});

/**
 * Bring up a Redis container as a devstack service.
 *
 * Returns a branded `StackMember` whose `provides` tag carries the
 * resolved handle. Pass the member by value to any downstream
 * consumer that needs the URL.
 *
 * @example
 * ```ts
 * import { defineDevstack } from '@mysten-incubation/devstack-rewrite';
 * import { redis } from './redis-plugin.ts';
 *
 * export default defineDevstack(redis({ route: true }));
 * ```
 */
export const redis = <const Name extends string = 'redis'>(
	opts: RedisOptions & { readonly name?: Name } = {},
) => {
	const name = (opts.name ?? 'redis') as Name;
	const tag = makeRedisTag(name);

	return defineNodePlugin({
		provides: tag,
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.gen(function* () {
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const dockerName = sanitizeDockerSegment(String(name));
				const containerName = `${identity.app}-${identity.stack}-${dockerName}`;

				const handle = yield* runtime
					.ensureContainer({
						name: containerName,
						image: redisImageRef(opts.image ?? DEFAULT_REDIS_IMAGE),
						labels: {
							app: identity.app,
							stack: identity.stack,
							plugin: 'redis',
							role: String(name),
						},
						recreate: 'on-config-change',
						command: [
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
					})
					.pipe(
						Effect.catch((cause) =>
							Effect.fail(
								redisError(
									'container-start',
									String(name),
									`failed to start redis container '${containerName}'`,
									cause,
								),
							),
						),
					);

				yield* awaitRedisReady(
					runtime,
					handle,
					String(name),
					opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
				);

				return {
					containerName,
					containerId: handle.id,
					networkAlias: containerName,
					endpoint: `redis://${containerName}:${REDIS_PORT}`,
					port: REDIS_PORT,
				} satisfies RedisHandle;
			}),
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: ['RedisPluginError'] }],
		capabilities: (resolved, acquireCtx) => {
			const routable: RoutableDecl | null =
				opts.route === true
					? makeRedisRoutable({
							app: acquireCtx.identity.app,
							stack: acquireCtx.identity.stack,
							name: String(name),
							containerName: resolved.containerName,
						})
					: null;
			return routable === null ? capabilities() : capabilities(routable);
		},
	});
};
