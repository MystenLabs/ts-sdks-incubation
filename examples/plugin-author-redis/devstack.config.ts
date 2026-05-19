// Demo devstack config consuming the local `./redis-plugin.ts`.
//
// `pnpm dev` from this directory brings up:
//   - The Redis container declared in `redis-plugin.ts`
//   - The shared traefik router, exposing `redis.plugin-author-redis.localhost`
//   - The standard devstack TUI showing the `redis` row alongside any
//     other services
//
// The Redis tag is `LayeredTag<'redis', DockerContainerHandle>`, so any
// downstream tag in this stack can `yield* Redis` to get the URL.

import { devstack } from '@mysten-incubation/devstack';
import { Redis } from './redis-plugin.js';

// Defaults are fine — pick `{maxMemory: '128mb'}` or override `name`
// when you need a per-stack distinct container alias.
const redis = Redis();

export default devstack(redis);
