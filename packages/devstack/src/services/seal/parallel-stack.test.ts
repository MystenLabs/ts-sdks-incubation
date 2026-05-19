// Phase 5 Subtopic 4 / TaskList #13 — parallel-stack readiness invariants
// for the seal primitive.
//
// Two devstack instances pointing at the same app with DIFFERENT `--stack`
// flags must boot concurrently without colliding on any host-side
// resource. The seal primitive owns three classes of host-visible state:
//
//   1. The routed hostname the on-chain `KeyServer.url` points at.
//      Traefik dispatches by `Host:` header so two stacks coexist on
//      the well-known seal port (2024).
//   2. The runtime config / master-key env-file under
//      `.devstack/stacks/<stack>/runtime/seal/`.
//   3. The docker container name (`<app>-<stack>-seal-<name>-key-server`,
//      composed by `Docker.run` from Identity).
//
// All three are stack-keyed in production code; this file is the gate
// that catches a future refactor accidentally folding the stack
// dimension out (e.g. by reaching for `routerHostname('seal')` without
// the identity arg, or hardcoding a container name without the
// app/stack prefix).
//
// Pure unit — no Docker, no supervisor. The docker-side end-to-end is
// `./parallel-stack.docker.test.ts`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { composeContainerName } from '../../engine/docker/core.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import type { IdentityShape } from '../../engine/identity.js';
import { buildCacheKey } from '../../engine/cache.js';

// Two stacks of the same app on the same network — the canonical
// "parallel devstack" shape. App is shared, network is shared
// (localnet), `stack` is the only dimension that differs.
const stackA: IdentityShape = { app: 'arena', stack: 'main', network: 'localnet' };
const stackB: IdentityShape = { app: 'arena', stack: 'preview', network: 'localnet' };

// Two stacks of the same app on different upstreams — the "fork against
// mainnet vs testnet concurrently" shape (P5.6.3).
const stackC: IdentityShape = { app: 'arena', stack: 'main', network: 'mainnet-fork' };
const stackD: IdentityShape = { app: 'arena', stack: 'main', network: 'testnet-fork' };

describe('services/seal parallel-stack invariants', () => {
	describe('routed hostname (Traefik Host: header dispatch)', () => {
		it('two stacks of the same app resolve to distinct seal hostnames', () => {
			const hostA = routerHostname(stackA, 'seal');
			const hostB = routerHostname(stackB, 'seal');
			// main: `seal.arena.localhost` — non-main: `<stack>.seal.arena.localhost`.
			// The dispatched hostname is the SDK consumer's URL via the
			// on-chain `KeyServer.url` field; if two stacks minted the same
			// hostname, both would route to whichever container Traefik
			// matched first.
			expect(hostA).toBe('seal.arena.localhost');
			expect(hostB).toBe('preview.seal.arena.localhost');
			expect(hostA).not.toBe(hostB);
		});

		it('Traefik router id is stack-scoped so per-stack labels do not collide', () => {
			// `traefik.http.routers.<id>.*` labels live in a single global
			// docker namespace — if two containers stamped the same id,
			// the second container would silently steal the first's
			// routing rule. The id folds `app-stack-service`.
			const idA = routerId(stackA, 'seal');
			const idB = routerId(stackB, 'seal');
			expect(idA).toBe('arena-main-seal');
			expect(idB).toBe('arena-preview-seal');
			expect(idA).not.toBe(idB);
		});
	});

	describe('docker container name composition', () => {
		it('two stacks of the same app mint distinct seal container names', () => {
			// `services/seal/internal.ts:665` hardcodes the primitive name
			// fragment `seal-${name}-key-server`. The final container name
			// is composed downstream by `Docker.run` via
			// `composeContainerName(app, stack, network, primitive)` which
			// folds the per-stack prefix in. Without that fold, two stacks
			// would try to docker-run a container with the same name and
			// the second `docker run --name` would 409.
			const nameA = composeContainerName(
				stackA.app,
				stackA.stack,
				stackA.network,
				'seal-seal-key-server',
			);
			const nameB = composeContainerName(
				stackB.app,
				stackB.stack,
				stackB.network,
				'seal-seal-key-server',
			);
			expect(nameA).toBe('arena-seal-seal-key-server');
			expect(nameB).toBe('arena-preview-seal-seal-key-server');
			expect(nameA).not.toBe(nameB);
		});

		it('per-fork variants on different upstreams (mainnet vs testnet) also mint distinct names', () => {
			const nameC = composeContainerName(
				stackC.app,
				stackC.stack,
				stackC.network,
				'seal-seal-key-server',
			);
			const nameD = composeContainerName(
				stackD.app,
				stackD.stack,
				stackD.network,
				'seal-seal-key-server',
			);
			// Same `<app, stack>` against two different upstream networks
			// gets the network suffix appended (`<app>-<stack>-<network>-`)
			// so flipping `network: 'mainnet-fork' → 'testnet-fork'`
			// doesn't adopt the wrong stack's containers.
			expect(nameC).toContain('mainnet-fork');
			expect(nameD).toContain('testnet-fork');
			expect(nameC).not.toBe(nameD);
		});
	});

	describe('state-store cache keys', () => {
		it('two stacks with different chainIds get distinct seal/bls-keypair cache keys', () => {
			// `services/seal/internal.ts` derives the BLS-keypair cache key
			// via `buildCacheKey({namespace: 'seal/bls-keypair/v1', chainId,
			// inputsHash})`. ChainId is per-stack (each stack runs its own
			// localnet / fork); a name-collision under the same key would
			// silently make one stack adopt the other's keypair.
			const keyA = buildCacheKey({
				namespace: 'seal/bls-keypair/v1',
				chainId: 'chainA',
				inputsHash: 'abc',
			});
			const keyB = buildCacheKey({
				namespace: 'seal/bls-keypair/v1',
				chainId: 'chainB',
				inputsHash: 'abc',
			});
			expect(keyA).not.toBe(keyB);
		});

		it('same chainId + same name produces the SAME cache key (intentional reuse on resume)', () => {
			// Within a single stack, the keypair cache key must be stable
			// across `pnpm dev` cycles so warm resume short-circuits the
			// keygen + register paths. The chainId-fold above is what
			// keeps it parallel-safe across stacks WITHOUT making it
			// non-deterministic within a stack.
			const k1 = buildCacheKey({
				namespace: 'seal/bls-keypair/v1',
				chainId: 'chainA',
				inputsHash: 'abc',
			});
			const k2 = buildCacheKey({
				namespace: 'seal/bls-keypair/v1',
				chainId: 'chainA',
				inputsHash: 'abc',
			});
			expect(k1).toBe(k2);
		});
	});

	describe('seal entrypoint port', () => {
		it('seal is intentionally served on a well-known port shared across stacks', () => {
			// Sanity / documentation check — `services/seal/internal.ts:105`
			// pins `DEFAULT_KEY_SERVER_PORT = 2024`. Two stacks coexist on
			// the same external port BY DESIGN because Traefik dispatches
			// by Host: header. If a future refactor accidentally surfaces
			// 2024 as the host port (e.g. via `PortAllocator.allocate` or
			// a `--publish 2024:2024`), parallel stacks would collide on
			// the host port and the second stack's `docker run` would
			// fail to bind.
			//
			// We re-import the module to assert the constant + the lack
			// of any host-port publish in the primitive body.
			const src = readFileSync(new URL('./internal.ts', import.meta.url), 'utf8');
			expect(src).toMatch(/DEFAULT_KEY_SERVER_PORT\s*=\s*2024/);
			// The `ports:` field on the runDockerContainer call would map
			// a host port to the container — if present, two stacks would
			// collide. The seal primitive uses `routing:` exclusively, so
			// `ports:` must not appear in the runDockerContainer payload
			// for the key-server.
			const keyServerCall = src.slice(src.indexOf('keyServerContainerName'));
			// Crude but effective: extract the runDockerContainer block
			// for the long-lived container and assert it has no `ports:`
			// field. We slice to the end of that call (next `).effect`).
			const callBlock = keyServerCall.slice(
				0,
				keyServerCall.indexOf(').effect') + ').effect'.length,
			);
			expect(callBlock).toMatch(/runDockerContainer/);
			// Forbidden: a `ports:` key inside this block would mean the
			// key-server is host-port-published (parallel-stack hostile).
			// Allowed: `containerApiPort` mentions inside comments.
			expect(callBlock).not.toMatch(/^\s*ports:\s*\{/m);
		});
	});
});
