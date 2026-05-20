// Phase 4 P4.T1-P4.T4 — fork CLI subcommand wiring.
//
// The `status` / `advance-clock` / `advance-checkpoint` cases require a
// running fork container with a reachable gRPC endpoint — those run as
// part of the docker-gated suite (`*.docker.test.ts`, gated behind
// `RUN_FORK_DOCKER_TESTS=1`). What this file covers:
//
//   - P4.T1 wiring: `fork status` reads the manifest, derives the gRPC
//     URL, and would dispatch a `forkingService.getStatus({})` against
//     it. We assert manifest discovery + upstream derivation in isolation.
//   - P4.T4: `fork seed list` + `fork seed diff` against a synthesized
//     on-disk meta.json. Pure-fs, no container required.
//
// Docker-gated companion: `fork.docker.test.ts` (deferred to a CI run
// alongside `RUN_FORK_DOCKER_TESTS=1`) exercises the live admin RPCs.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { computeConfigHash } from '../../engine/sui-fork/meta.js';
import { _internal } from './fork/index.js';

describe('cli/commands/fork', () => {
	describe('manifest discovery + upstream derivation (P4.T1 wiring)', () => {
		it.effect('reads services.sui from a manifest and derives the upstream', () =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-cli-')));
				const stateDir = joinPath(root, '.devstack');
				const stackDir = joinPath(stateDir, 'stacks', 'main');
				yield* Effect.promise(() => mkdir(stackDir, { recursive: true }));
				const manifest = {
					stack: { name: 'main', network: 'testnet-fork', app: 'fixture' },
					services: {
						sui: {
							network: 'testnet-fork',
							chainId: '4c78adac',
							rpc: { url: 'http://sui-grpc.fixture.localhost:50051' },
						},
					},
					packages: {},
					accounts: {},
					coins: {},
					app: { extras: {} },
				};
				yield* Effect.promise(() =>
					writeFile(joinPath(stackDir, 'manifest.json'), JSON.stringify(manifest)),
				);
				const prevCwd = process.cwd();
				const prevAppDir = process.env.DEVSTACK_APP_DIR;
				const prevStateDir = process.env.DEVSTACK_STATE_DIR;
				const prevStackEnv = process.env.DEVSTACK_STACK;
				const prevManifest = process.env.DEVSTACK_MANIFEST_PATH;
				try {
					process.env.DEVSTACK_APP_DIR = root;
					process.env.DEVSTACK_STATE_DIR = stateDir;
					process.env.DEVSTACK_STACK = 'main';
					delete process.env.DEVSTACK_MANIFEST_PATH;
					const ctx = yield* _internal.resolveForkRuntimeCtx('main');
					expect(ctx.stack).toBe('main');
					expect(ctx.upstream).toBe('testnet');
					expect(ctx.rpcUrl).toBe('http://sui-grpc.fixture.localhost:50051');
					expect(ctx.chainId).toBe('4c78adac');
				} finally {
					if (prevAppDir === undefined) delete process.env.DEVSTACK_APP_DIR;
					else process.env.DEVSTACK_APP_DIR = prevAppDir;
					if (prevStateDir === undefined) delete process.env.DEVSTACK_STATE_DIR;
					else process.env.DEVSTACK_STATE_DIR = prevStateDir;
					if (prevStackEnv === undefined) delete process.env.DEVSTACK_STACK;
					else process.env.DEVSTACK_STACK = prevStackEnv;
					if (prevManifest === undefined) delete process.env.DEVSTACK_MANIFEST_PATH;
					else process.env.DEVSTACK_MANIFEST_PATH = prevManifest;
					process.chdir(prevCwd);
				}
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);
	});

	describe('collectReferencedChainIds (P4.T4 + cache list)', () => {
		it.effect('walks per-stack meta.json files and folds upstream + chainId into the set', () =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-fork-cli-')));
				const stateDir = joinPath(root, '.devstack');
				const oneDir = joinPath(stateDir, 'stacks', 'one', 'sui-fork');
				const twoDir = joinPath(stateDir, 'stacks', 'two', 'sui-fork');
				yield* Effect.promise(() => mkdir(oneDir, { recursive: true }));
				yield* Effect.promise(() => mkdir(twoDir, { recursive: true }));
				const metaA = {
					version: 1,
					createdAt: 0,
					upstream: 'testnet',
					chainId: '4c78adac',
					configHash: computeConfigHash({
						upstream: 'testnet',
						seedAddresses: [],
						seedObjects: [],
					}),
					seedAddresses: [] as string[],
					seedObjects: [] as string[],
				};
				const metaB = {
					version: 1,
					createdAt: 0,
					upstream: 'mainnet',
					configHash: computeConfigHash({
						upstream: 'mainnet',
						seedAddresses: [],
						seedObjects: [],
					}),
					seedAddresses: [] as string[],
					seedObjects: [] as string[],
				};
				yield* Effect.promise(() =>
					writeFile(joinPath(oneDir, 'meta.json'), JSON.stringify(metaA)),
				);
				yield* Effect.promise(() =>
					writeFile(joinPath(twoDir, 'meta.json'), JSON.stringify(metaB)),
				);
				const referenced = yield* Effect.promise(() =>
					_internal.collectReferencedChainIds(stateDir),
				);
				expect(referenced.has('4c78adac')).toBe(true);
				expect(referenced.has('testnet')).toBe(true);
				expect(referenced.has('mainnet')).toBe(true);
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);
	});

	describe('cache list + prune marker logic (P4.T1-P4.T4 supporting helper)', () => {
		it.effect('collectCacheEntries marks unreferenced chainIds correctly', () =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() =>
					mkdtemp(joinPath(tmpdir(), 'devstack-fork-cache-')),
				);
				const cacheRoot = joinPath(root, 'sui-fork-cache');
				yield* Effect.promise(() => mkdir(joinPath(cacheRoot, 'testnet'), { recursive: true }));
				yield* Effect.promise(() =>
					mkdir(joinPath(cacheRoot, 'orphan-chain'), { recursive: true }),
				);
				yield* Effect.promise(() =>
					writeFile(joinPath(cacheRoot, 'testnet', 'sample.bin'), Buffer.from('hello')),
				);
				const referenced = new Set<string>(['testnet']);
				const entries = yield* Effect.promise(() =>
					_internal.collectCacheEntries(cacheRoot, referenced),
				);
				const testnet = entries.find((e) => e.chainId === 'testnet');
				const orphan = entries.find((e) => e.chainId === 'orphan-chain');
				expect(testnet?.referenced).toBe(true);
				expect(orphan?.referenced).toBe(false);
				expect(testnet?.bytes).toBeGreaterThan(0);
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
		);
	});
});
