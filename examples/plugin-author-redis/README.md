# plugin-author-redis

A minimal example demonstrating how to wrap an arbitrary Docker
container as a devstack service from out-of-tree code.

## What it shows

`redis-plugin.ts` is the centerpiece. It uses the
`/advanced/plugin-author` surface of `@mysten-incubation/devstack` to:

1. Register a traefik entrypoint at module load time via
   `defineEntrypoint({ name: 'redis', port: 16379 })`.
2. Wrap a `redis:7-alpine` container as a `LayeredTag` via
   `dockerContainer(name, options)`.
3. Configure a TCP ready probe so the tag's resolution waits for the
   server to accept connections.
4. Route the container through the shared traefik router as
   `redis.plugin-author-redis.localhost` for host-side dashboard
   observability.
5. Publish a `REDIS` endpoint into the manifest / codegen / TUI.

`devstack.config.ts` then composes the `Redis()` factory into a stack
with one call.

This pattern is what every out-of-tree devstack plugin should follow:
its primitives live in a standalone file (`redis-plugin.ts` here) that
imports only from `@mysten-incubation/devstack/advanced`. User configs
import the plugin from npm (or, here, from the local file) and treat
it as a black-box `Redis()` factory.

## Run it

```bash
pnpm install
pnpm dev
```

Expected:

- TUI shows one `redis` row in the Services section.
- `docker ps` lists a `plugin-author-redis-<stack>-redis` container.
- `curl -v http://redis.plugin-author-redis.localhost:16379` opens a
  TCP connection (Redis isn't HTTP, so curl gets a protocol mismatch,
  but the connection itself proves the routing wired up).
- `redis-cli -p <host port from `devstack stack`> ping` returns `PONG`.

## What this is NOT

This example is intentionally minimal — no Move package, no Vite app,
no e2e tests. It exists to exercise the plugin-author surface from a
real out-of-tree callsite. For a full-featured example (Move +
publish + dapp-kit + e2e), see `examples/_template/`.
