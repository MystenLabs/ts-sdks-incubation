import { Effect } from 'effect';

import { definePlugin } from '../core.ts';
import { defineDevstack, hostService } from '../builtins.ts';
import { redis } from './redis-plugin.ts';

interface CacheWarmupValue {
	warmed: true;
	redisUrl: string;
}

export const cache = redis('cache');

export const warmCache = definePlugin({
	id: 'cache-warmup/arena',
	dependsOn: cache,
	kind: 'leaf-one-shot',
	rebootCost: 'cheap',
	start: (_ctx, redisCache) => {
		return redisCache.flush().pipe(
			Effect.as({
				warmed: true,
				redisUrl: redisCache.url,
			} satisfies CacheWarmupValue),
		);
	},
});

export const cacheBackedApp = hostService({
	name: 'cache-backed-app',
	command: 'pnpm dev',
	port: 5177,
	dependsOn: { cache, warmCache },
	env: (_ctx, { cache, warmCache }) => ({
		REDIS_URL: cache.url,
		CACHE_WARMED: String(warmCache.warmed),
	}),
});

export const customPluginStack = defineDevstack({
	members: [cacheBackedApp],
	stackName: 'custom-plugin',
});

export const redisUrl = 'redis://127.0.0.1:6379/cache';
