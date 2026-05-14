// End-to-end integration smoke for the full devstack layer-build path.
//
// This test exists because 10+ rounds of review missed several
// layer-composition bugs (Layer.mergeAll vs provideMerge, NodeServicesLayer
// vs hand-rolled mergeAll, inverted `provideMerge` argument order, parallel
// `mergeAll(...stackLayers)` instead of a left-fold with `provideMerge`).
// Every one of those bugs survived because every other test in this package
// bypasses `composeStackLayer` or only asserts `Layer.isLayer(...)`. The
// suite below builds the SAME layer the CLI does (`pnpm exec devstack up`
// flows through `defineDevstack` → `composeStackLayer` → `Layer.build`),
// with the spawner / fetch swapped out so the test doesn't actually shell
// out to Docker or hit the network.
//
// The mock spawner is wired via `composeStackLayer`'s `platformLayer`
// override: we re-mergeAll the real Node Path / Stdio / Terminal /
// FileSystem against our in-memory ChildProcessSpawner. If anything in
// the user-layer → InfraLive → PlatformLive chain regresses (a missing
// `provideMerge`, a swapped argument, a stale `Layer.provide`), the build
// here fails with `ServiceNotFound` — and we catch it before it ships.
//
// Coverage focuses on the LAYER-COMPOSITION path, not Docker itself. The
// mock returns synthetic container IDs and pretends every `docker ps` /
// `docker rm` is fine. Whether the resulting containers are CORRECTLY
// CONFIGURED is the job of the per-primitive unit tests.

import { Context, Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { layer as NodePathLayer } from '@effect/platform-node/NodePath';
import { layer as NodeStdioLayer } from '@effect/platform-node/NodeStdio';
import { layer as NodeTerminalLayer } from '@effect/platform-node/NodeTerminal';
import { describe, expect, it } from '@effect/vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeStackLayer } from './define-devstack.js';
import { PortAllocator } from './internal/port-allocator.js';
import { accounts } from './primitives/accounts.js';
import { Sui, suiLocalnet } from './primitives/sui.js';

// -----------------------------------------------------------------------------
// Mock ChildProcessSpawner
// -----------------------------------------------------------------------------
//
// Records every `spawn` call's argv so assertions can verify the docker
// invocation shape. The handle's stdout / stderr / exitCode are routed by
// command argv: `network create` / `run` / `exec` all have distinct
// canned responses, with a default of "exit 0, stdout=<synthetic>" so
// finalizers (`docker rm -f`, `docker network rm`) don't have to be
// special-cased.

interface SpawnRecord {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
}

const FAKE_CONTAINER_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';

const makeMockSpawnerLayer = (recorder: Array<SpawnRecord>) => {
	const handleStdout = (args: ReadonlyArray<string>): string => {
		// `docker run` → container id on stdout.
		if (args[0] === 'run') return `${FAKE_CONTAINER_ID}\n`;
		// `docker network create <name>` → echoes the network name.
		if (args[0] === 'network' && args[1] === 'create') return `${args[args.length - 1]}\n`;
		// `docker image inspect -f '{{.Id}}' <tag>` → synthetic digest so
		// `Docker.pull`/`Docker.build`'s post-build inspect resolves to a
		// non-empty string. The vendored `sui-image/` build path threads
		// through this branch on every integration run.
		if (args[0] === 'image' && args[1] === 'inspect') return `sha256:${'0'.repeat(64)}\n`;
		// `docker inspect --format '{{(index .NetworkSettings.Networks
		// "<net>").IPAddress}}'` → synthetic router-network IP. Drives
		// the file-provider materialization in `Docker.run({traefik:
		// [...]})`; without a non-empty response the helper retries
		// for 3s and the test times out.
		if (args[0] === 'inspect') {
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt !== undefined && fmt.includes('NetworkSettings.Networks')) {
				return '172.21.0.3\n';
			}
		}
		// `docker exec <id> pg_isready ...` → realistic ready output.
		if (args[0] === 'exec' && args[2] === 'pg_isready')
			return '/var/run/postgresql:5432 - accepting connections\n';
		return '';
	};

	const spawn = (command: ChildProcess.Command) => {
		// Only StandardCommand has command/args; this test never builds piped
		// commands so the narrow is safe.
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error(`integration mock: unexpected piped command`));
		}
		recorder.push({ command: command.command, args: [...command.args] });
		const stdoutText = handleStdout(command.args);
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(1234),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout: Stream.succeed(new TextEncoder().encode(stdoutText)),
			stderr: Stream.empty,
			all: Stream.succeed(new TextEncoder().encode(stdoutText)),
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};

	const impl = ChildProcessSpawner.make(spawn);
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, impl);
};

// Compose a platform layer that swaps the real Node spawner for our
// in-memory mock. We keep the rest of NodeServices (FileSystem / Path /
// Stdio / Terminal) so `StateStoreLive` and `accounts`'s file-keystore
// branch can still write to a real scratch dir.
const makeMockPlatformLayer = (recorder: Array<SpawnRecord>) =>
	Layer.mergeAll(
		makeMockSpawnerLayer(recorder),
		NodeFileSystemLayer,
		NodePathLayer,
		NodeStdioLayer,
		NodeTerminalLayer,
	) as unknown as Layer.Layer<unknown, unknown, never>;

// Deterministic `PortAllocator` for integration tests. The real
// `PortAllocatorLive` does a TCP bind probe on `0.0.0.0` and
// `127.0.0.1`, which on a developer machine running Docker Desktop
// (or a CI runner with anything bound on 9000 / 9123 / 9125) scans
// past the preferred port to the next free slot — so the resulting
// `Sui.rpcUrl` ends up `http://localhost:9001` or similar, the
// fetch stub (matching ONLY `:9000` / `:9123`) falls through to the
// default `'{}'` response, `client.getChainIdentifier()` retries
// forever, and the layer build never completes. This stub bypasses
// the probe and just hands back the preferred port — `suiLocalnet`
// then publishes `http://localhost:9000`, the stub fetch matches,
// and the ready-probe succeeds on the first attempt. Wired via
// `composeStackLayer`'s `infraOverrides` seam so `Layer.mergeAll`'s
// later-wins semantics shadow `PortAllocatorLive` inside the
// composed infra ring.
const makeTestPortAllocatorLayer = () =>
	Layer.succeed(PortAllocator, {
		allocate: (preferred: number) => Effect.succeed(preferred),
		release: () => Effect.void,
		snapshot: Effect.succeed([] as ReadonlyArray<number>),
	}) as unknown as Layer.Layer<unknown, unknown, never>;

// Stub `globalThis.fetch` so SuiJsonRpcClient.getChainIdentifier(),
// awaitReady's HTTP probe, and the faucet POST all resolve without a
// real network. Returns a `restore()` cleanup the surrounding test must
// call.
//
// `getChainIdentifier` calls `sui_getCheckpoint({id:'0'})` then base58-
// decodes `result.digest` and hex-encodes the first 4 bytes; any valid
// >=4-byte base58 string makes the decode succeed.
const STUB_CHECKPOINT_DIGEST = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const stubFetch = (): (() => void) => {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = typeof input === 'string' ? input : (input as URL | Request).toString();
		// Sui JSON-RPC POSTs → return a happy getCheckpoint envelope. The
		// localnet `awaitReady` probe and `fetchChainId` both go through
		// `http://localhost:9000/`.
		if (url.includes(':9000')) {
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: {
						digest: STUB_CHECKPOINT_DIGEST,
						sequenceNumber: '0',
						epoch: '0',
						networkTotalTransactions: '0',
						timestampMs: '0',
						previousDigest: null,
						transactions: [],
						checkpointCommitments: [],
						validatorSignature: '',
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}
		// Faucet (`http://localhost:9123/v2/gas`) → 200 OK with empty body.
		// `requestFunds` only cares about the response status.
		if (url.includes(':9123')) {
			return new Response('{}', { status: 200 });
		}
		// Default: pretend any other URL is reachable so we never accidentally
		// fall back to the real network in CI.
		return new Response('{}', { status: 200 });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('devstack integration smoke', () => {
	it.effect('composeStackLayer builds the full graph and resolves Sui + account', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const tmpDir = mkdtempSync(join(tmpdir(), 'devstack-int-'));
			const restore = stubFetch();
			// Pin the router file-provider dir to a per-test temp dir so
			// the YAMLs Docker.run materializes for sui-localnet land
			// somewhere we can inspect without touching the real
			// `~/.devstack/traefik/dynamic`.
			const routerDir = join(tmpDir, 'router');
			const savedRouterEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = routerDir;
			try {
				const a = accounts({ alice: {} });
				const layer = composeStackLayer([suiLocalnet(), a.alice], {
					stackName: 'integration',
					network: 'localnet',
					stateDir: tmpDir,
					platformLayer: makeMockPlatformLayer(recorder),
					infraOverrides: makeTestPortAllocatorLayer(),
				});

				// `Layer.build` returns the resolved Context — exactly what
				// `defineDevstack.runOnce` does via `Layer.buildWithMemoMap`. If
				// any of the recent layer-composition fixes regress (mergeAll
				// vs provideMerge, swapped argument order, missing Platform
				// layer, etc.) this fails with ServiceNotFound during build.
				const ctx = yield* Layer.build(layer as Layer.Layer<unknown, never, never>);

				const sui = Context.get(ctx, Sui);
				expect(sui.network).toBe('localnet');
				// Router-fronted hostname URL on the well-known sui-rpc
				// entrypoint port (9000). The stack name flows through
				// `routerHostname` — non-main stacks get a `<stack>.`
				// prefix on the hostname.
				expect(sui.rpc.host).toBe('http://integration.sui.devstack-effect.localhost:9000');
				// Container-side URL points at the docker-DNS alias on
				// sui's in-container port; consumer containers (walrus
				// deploy/nodes, seal key-server) dial this form after
				// joining one of `rpc.containerNetworks`.
				expect(sui.rpc.container).toBe('http://sui-localnet:9000');
				expect(sui.rpc.containerNetworks?.[0]).toMatch(
					/^devstack-effect-integration-sui-network$/,
				);
				expect(sui.chainId).toMatch(/^[0-9a-f]+$/);

				// Per-account tag — its `__layer` was folded into the user
				// stack and built like any other. The body yields the same
				// Account shape regardless of which `from:` produced the key.
				const account = Context.get(ctx, a.alice);
				expect(account.address).toMatch(/^0x[0-9a-f]+$/);

				// `Docker.run` must have been invoked with the expected
				// `--name`, `--image`, and `-p` flags. Missing any of these
				// would indicate a misconstructed argv in `internal/docker.ts`.
				// Container names are scoped `{app}-{stack}-{primitive}` with
				// any periods in the primitive name folded to hyphens; `{app}`
				// is the package-name-derived value (here `devstack-effect`)
				// and `{stack}` is the configured `stackName` (`'integration'`,
				// not the default `'main'`, so it's included in the prefix).
				//
				// Filter on `args[0] === 'run'` to skip the reuse-if-healthy
				// `docker inspect <name>` probe that fires before `docker run`
				// for every container — it includes the name in its argv too.
				const localnetName = 'devstack-effect-integration-sui-localnet';
				const localnetRun = recorder.find(
					(r) => r.command === 'docker' && r.args[0] === 'run' && r.args.includes(localnetName),
				);
				expect(localnetRun).toBeDefined();
				expect(localnetRun?.args).toContain('--name');
				expect(localnetRun?.args).toContain(localnetName);
				// Sui no longer publishes host ports (rpc/faucet/graphql
				// reach this container through the shared Traefik
				// router on the well-known entrypoint ports). The router
				// is now wired via file-provider YAMLs written below.
				expect(localnetRun?.args.some((a) => a.endsWith(':9000:9000'))).toBe(false);
				// No `traefik.*` labels — those drove the docker
				// provider, which we removed because of an IP-resolution
				// race against the per-stack vs router-network attach
				// order. See `internal/docker/router.ts` architecture
				// comment.
				expect(localnetRun?.args.some((a) => a.startsWith('traefik.'))).toBe(false);
				// Instead, `Docker.run` attaches the container to
				// `devstack-router` after `docker run` and writes one
				// file-provider YAML per service (rpc / faucet /
				// graphql) under `DEVSTACK_ROUTER_DYNAMIC_DIR`, with the
				// resolved router-network IP folded into the upstream
				// URL. The YAMLs are how Traefik (file-provider only)
				// dispatches to this container.
				expect(
					recorder.some(
						(r) =>
							r.args[0] === 'network' && r.args[1] === 'connect' && r.args[2] === 'devstack-router',
					),
				).toBe(true);
				const yamlNames = readdirSync(routerDir);
				expect(yamlNames).toContain('devstack-effect-integration-sui-rpc.yml');
				expect(yamlNames).toContain('devstack-effect-integration-sui-faucet.yml');
				expect(yamlNames).toContain('devstack-effect-integration-sui-graphql.yml');
				// Each YAML carries the synthetic IP from the mock spawner.
				const rpcYaml = readFileSync(
					join(routerDir, 'devstack-effect-integration-sui-rpc.yml'),
					'utf8',
				);
				expect(rpcYaml).toContain('http://172.21.0.3:9000');
				// Image is content-addressed from the vendored `sui-image/`
				// Dockerfile + entrypoint + SUI_VERSION; the `dockerImage`
				// runner stamps `devstack-sui.image:<treeHash>-<configHash>`.
				expect(localnetRun?.args.some((a) => a.startsWith('devstack-sui.image:'))).toBe(true);
				// Docker Desktop UI grouping label — `docker compose`'s
				// default project naming convention is the directory; we
				// mirror that with `{app}` for the default `main` stack and
				// `{app}-{stack}` otherwise.
				expect(
					localnetRun?.args.some(
						(a) => a === 'com.docker.compose.project=devstack-effect-integration',
					),
				).toBe(true);

				// The postgres sidecar gets its own `docker run` ahead of sui.
				// Same `args[0] === 'run'` filter as above so the inspect probe
				// doesn't shadow the actual run argv.
				const pgName = 'devstack-effect-integration-sui-indexer-db';
				const pgRun = recorder.find((r) => r.args[0] === 'run' && r.args.includes(pgName));
				expect(pgRun).toBeDefined();
				expect(pgRun?.args.some((a) => a.startsWith('postgres:'))).toBe(true);

				// A `docker network create ... -sui-network` should have been
				// issued before either container. Network names are managed by
				// `Docker.networkCreate` (not `Docker.run`) and follow the same
				// `{app}-[{stack}-]sui-network` pattern as container names.
				const netCreate = recorder.find(
					(r) =>
						r.args[0] === 'network' &&
						r.args[1] === 'create' &&
						r.args.some((a) => a.endsWith('-sui-network')),
				);
				expect(netCreate).toBeDefined();
			} finally {
				restore();
				if (savedRouterEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedRouterEnv;
				}
				yield* Effect.promise(() => rm(tmpDir, { recursive: true, force: true }));
			}
		}),
	);

	it.effect('layer feeds an Effect.provide consumer (the provideDevstack shape)', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const tmpDir = mkdtempSync(join(tmpdir(), 'devstack-int-'));
			const restore = stubFetch();
			try {
				// `provideDevstack` is a thin wrapper around `composeStackLayer`
				// — its only job is to forward stackName / network / stateDir.
				// We exercise the SAME consumption pattern (`Effect.provide`
				// the composed layer into a caller-owned `Effect.gen`) so a
				// future refactor that splits the two paths doesn't silently
				// regress one of them. We call `composeStackLayer` directly
				// here so we can inject the mock platform via its public
				// integration-test seam (`platformLayer`), which
				// `provideDevstack`'s narrower option shape doesn't surface.
				const a = accounts({ alice: {} });
				const layer = composeStackLayer([suiLocalnet(), a.alice], {
					stackName: 'integration-provide',
					network: 'localnet',
					stateDir: tmpDir,
					platformLayer: makeMockPlatformLayer(recorder),
					infraOverrides: makeTestPortAllocatorLayer(),
				});

				const program = Effect.gen(function* () {
					const sui = yield* Sui;
					const acc = yield* a.alice;
					return { network: sui.network, address: acc.address };
				});

				const result = yield* program.pipe(
					Effect.provide(layer as Layer.Layer<unknown, never, never>),
					Effect.scoped,
				);
				expect(result.network).toBe('localnet');
				expect(result.address).toMatch(/^0x[0-9a-f]+$/);
				// Cross-check: the `Effect.provide` path also hit Docker.run
				// with the scoped container name (`integration-provide` stack).
				expect(
					recorder.some((r) => r.args.includes('devstack-effect-integration-provide-sui-localnet')),
				).toBe(true);
			} finally {
				restore();
				yield* Effect.promise(() => rm(tmpDir, { recursive: true, force: true }));
			}
		}),
	);
});
