import { Effect } from 'effect';

import { definePlugin } from '../core.ts';
import { defineDevstack, hostService } from '../builtins.ts';
import type { RedisValue } from './redis-plugin.ts';

const redisSidecar = hostService({
	name: 'redis-sidecar',
	command: 'redis-server',
	port: 6380,
});

const redisGroup = definePlugin({
	id: 'redis/grouped',
	dependsOn: redisSidecar,
	kind: 'group',
	start: (_ctx, sidecar) =>
		Effect.succeed({
			name: 'grouped',
			url: sidecar.url.replace('http://', 'redis://'),
			flush: () => Effect.void,
		} satisfies RedisValue),
});

export const groupStack = defineDevstack({ members: [redisGroup] });
