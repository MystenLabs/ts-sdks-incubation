// Walrus phases 2 + 5 — contract deploy + exchange-object discovery.
//
// `deployContracts` runs the upstream walrus-deploy one-shot against
// the local sui chain (publishes the Move package, registers the
// initial committee, optionally creates a wal_exchange) and parses
// the on-disk `deploy` summary the script writes.
//
// `parseDeployFile` mirrors v3's parser byte-for-byte — the upstream
// walrus-deploy tool writes `key: value` newline-separated pairs with
// `None` sentinels for absent optional fields.
//
// `resolveExchange` reads the exchange object's `.type` on chain to
// recover the `wal_exchange` package id — the deploy summary only
// records the object id. Kept in this file because exchange discovery
// is part of the post-deploy state hydration that happens before the
// storage nodes start.
//
// Spans: `walrus.deploy`, `walrus.exchange` (preserved).

import { Effect, FileSystem } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import * as Docker from '../../engine/docker.js';
import type { Endpoint } from '../../engine/endpoint.js';
import { EngineHandle } from '../../engine/engine.js';
import { Identity, type IdentityShape } from '../../engine/identity.js';
import { routerHostname } from '../../engine/router-hostname.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { WalrusError } from '../../engine/errors.js';
import type { DeployState, ExchangeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';

// Build a per-line sink that forwards each line to the supervisor's
// log channel (when an engine is wired into the context). Lines are
// tagged with the primitive label so a multi-step boot's TUI tail
// reads e.g. `[walrus.deploy] WAL exchange registered ...` instead
// of an unattributed sea of `docker run` output.
const makeOutputLineSink = (label: string): Effect.Effect<Docker.OutputLineCallback> =>
	Effect.gen(function* () {
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		return (level, line) =>
			engineOpt._tag === 'None'
				? Effect.void
				: engineOpt.value
						.appendLog({ ts: Date.now(), level, message: `[${label}] ${line}` })
						.pipe(Effect.ignore);
	});

// -----------------------------------------------------------------------------
// Phase 2: deploy
// -----------------------------------------------------------------------------

export const deployContracts = (args: {
	name: string;
	image: string;
	/**
	 * Sui RPC `Endpoint`. The deploy one-shot dials it from inside a
	 * container, so it MUST be reached via `rpc.container` (the
	 * docker-DNS alias `http://sui-localnet:9000`). Host-form
	 * `rpc.host` is the fallback for externally-managed RPCs where
	 * no docker-side address exists; the caller is then responsible
	 * for ensuring `host` is reachable from whatever default network
	 * the one-shot lands on.
	 */
	rpc: Endpoint;
	/** Sui faucet `Endpoint`; same `container`-preferred logic as `rpc`. */
	faucet: Endpoint | undefined;
	/**
	 * Per-stack docker network the sui-localnet container belongs to.
	 * The deploy container joins this network so docker DNS resolves
	 * `sui-localnet` to sui's container IP. Undefined for externally-
	 * managed RPCs — the caller is responsible for ensuring the
	 * provided `rpc.host` is reachable from whatever default network
	 * the one-shot lands on.
	 */
	suiNetwork: string | undefined;
	nodeCount: number;
	shards: number;
	epochDuration: string;
	containerApiPort: number;
	/**
	 * Well-known host port the Traefik router binds for the `walrus`
	 * entrypoint (9185). Recorded on chain as each storage node's
	 * `public_port` via `WALRUS_REST_API_PORT`. Identical for every
	 * stack — disambiguation is by `Host:` header on the
	 * stack-scoped `walrus-node-N.<app>.localhost` hostnames the
	 * router dispatches by.
	 */
	routerEntrypointPort: number;
	/**
	 * Identity used to mint stack-scoped `WALRUS_PUBLIC_HOSTS` (the
	 * hostnames each storage node registers as its `network_address`
	 * on chain). With the Traefik router in front, those hostnames
	 * resolve through the router to the right per-stack backend.
	 */
	identity: IdentityShape;
	outputDir: string;
	subnetPrefix: string;
}): Effect.Effect<
	DeployState,
	WalrusError,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Identity
> =>
	Effect.fn('walrus.deploy')(function* () {
		const fs = yield* FileSystem.FileSystem;

		// Carve out a host directory for the deploy outputs. Bind-mounted
		// into the deploy one-shot (rw) and the storage node containers
		// (ro). Lives under `<cwd>/.devstack/walrus/<name>/deploy` rather
		// than v3's per-stack path — devstack has no env-aware
		// path helper yet.
		const outputDir = args.outputDir;
		yield* fs.makeDirectory(outputDir, { recursive: true }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: failed to prep output dir '${outputDir}': ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);

		// Sui URL pair the deploy script reads via `WALRUS_NETWORK`.
		// Prefer the docker-DNS URL (`http://sui-localnet:9000`) when
		// `suiLocalnet` populated `rpc.container` — the deploy
		// container joins `args.suiNetwork` below and resolves the
		// alias via docker DNS, bypassing the `.localhost` glibc trap.
		// Externally-managed RPCs leave `container` undefined; we then
		// fall back to the routed `host` URL and the caller is
		// responsible for reachability.
		const stripTrailingSlash = (u: string): string => (u.endsWith('/') ? u.slice(0, -1) : u);
		const inNetworkRpc = stripTrailingSlash(args.rpc.container ?? args.rpc.host);
		const inNetworkFaucet = stripTrailingSlash(
			args.faucet?.container ?? args.faucet?.host ?? inNetworkRpc,
		);

		// Stack-scoped hostnames: storage nodes register
		// `walrus-node-N.<app>.localhost` (main) or
		// `<stack>.walrus-node-N.<app>.localhost` (non-main) as their
		// `network_address` on chain. The Traefik router dispatches by
		// `Host:` header to each node's pinned in-network IP. Two
		// parallel stacks of the same app advertise disjoint hostnames
		// and never trample each other's on-chain committee record.
		const publicHosts = Array.from({ length: args.nodeCount }, (_, i) =>
			routerHostname(args.identity, `walrus-node-${i}`),
		).join(' ');
		// Pinned subnet IPs that the storage-node containers will claim
		// at startup (see `startStorageNodes`). deploy-walrus.sh requires
		// `WALRUS_LISTENING_IPS` to agree with those `--ip` pins so the
		// on-chain committee record's bind addresses match what the
		// nodes actually listen on. Kept in lockstep with the IP
		// computation in `startStorageNodes`.
		const listeningIps = Array.from(
			{ length: args.nodeCount },
			(_, i) => `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`,
		).join(' ');

		// v3's deploy-walrus.sh expects these env vars exactly. The
		// public image likely lacks the script — see the deploy result
		// check below for the fallback path.
		//
		// `WALRUS_REST_API_PORT` is passed to `walrus-deploy` as
		// `--rest-api-port`, which becomes each storage node's on-chain
		// `public_port`. Two parallel stacks both registering `:9185`
		// caused SDK clients keyed on `Host: walrus-node-N.localhost:9185`
		// to land on whichever proxy bound that host port first (cross-
		// stack collision). We register the allocator-issued proxy host
		// port instead — Stack B that shifts the proxy to 9186 now
		// advertises `:9186` on its own chain, and the SDK dials the
		// right proxy. Storage nodes still BIND on `containerApiPort`
		// (9185) inside the container; the nginx proxy translates from
		// the external `<proxyPort>` host port to the in-network
		// `containerApiPort`.
		const env: Record<string, string> = {
			WALRUS_PUBLIC_HOSTS: publicHosts,
			WALRUS_LISTENING_IPS: listeningIps,
			// Same for every stack now (no allocator-issued shift): the
			// router binds 9185 once on the host and routes by Host
			// header to the per-stack backend.
			WALRUS_REST_API_PORT: String(args.routerEntrypointPort),
			WALRUS_COMMITTEE_SIZE: String(args.nodeCount),
			WALRUS_SHARDS: String(args.shards),
			WALRUS_EPOCH_DURATION: args.epochDuration,
			WALRUS_NETWORK: `${inNetworkRpc};${inNetworkFaucet}/gas`,
		};

		const onOutputLine = yield* makeOutputLineSink('walrus.deploy');
		const result = yield* Docker.runOneShot({
			name: `walrus-${args.name}-deploy`,
			image: args.image,
			env,
			mounts: [{ host: outputDir, container: '/opt/walrus/outputs' }],
			args: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
			// Join the per-stack sui docker network so the deploy
			// script resolves `sui-localnet` via docker DNS. The
			// routed `.localhost` URLs would NXDOMAIN inside a glibc
			// container (RFC 6761 only fires on the host OS). When
			// `suiNetwork` is undefined (externally-managed RPC), the
			// one-shot lands on docker's default bridge and the
			// caller-provided `rpcUrl` is responsible for reachability.
			...(args.suiNetwork !== undefined ? { network: args.suiNetwork } : {}),
			// Stream deploy.sh stdout/stderr into the supervisor TUI
			// log as it arrives. Without this, a failed deploy surfaces
			// only after `docker run` exits, and `--rm` (default for
			// one-shots) has already destroyed the container — so the
			// user can't `docker logs` the corpse. Set
			// `DEVSTACK_KEEP_ONESHOT=1` to additionally preserve the
			// container post-mortem.
			onOutputLine,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: container failed: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'deploy',
					message: `walrus.deploy: deploy script exited ${result.exitCode} (image ${args.image})`,
					stderr: result.stderr,
					stdout: result.stdout,
					exitCode: result.exitCode,
				}),
			);
		}

		// v3 reads `<outputDir>/deploy` (a plain `key: value` file). We
		// reproduce its parser inline so the only host-side dependency
		// is whatever the deploy script wrote.
		const deployFile = `${outputDir}/deploy`;
		const text = yield* fs.readFileString(deployFile).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: could not read deploy summary at ${deployFile}: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);
		return yield* parseDeployFile(outputDir, text);
	})();

// `parseDeployFile` mirrors v3's `parseDeployFile` byte-for-byte (the
// upstream walrus-deploy tool writes `key: value` newline-separated
// pairs with `None` sentinels for absent optional fields).
const parseDeployFile = (
	outputDir: string,
	text: string,
): Effect.Effect<DeployState, WalrusError> =>
	Effect.gen(function* () {
		const get = (key: string): string | undefined => {
			const m = text.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
			const value = m?.[1];
			if (value === undefined || value === 'None') return undefined;
			return value;
		};
		const walrusPackageId = get('package_id');
		const systemObject = get('system_object');
		const stakingObject = get('staking_object');
		if (
			walrusPackageId === undefined ||
			systemObject === undefined ||
			stakingObject === undefined
		) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'deploy',
					message:
						`walrus.deploy: deploy file missing one of ` +
						`{package_id, system_object, staking_object}:\n` +
						text.slice(0, 400),
				}),
			);
		}
		const state: DeployState = {
			outputDir,
			walrusPackageId,
			systemObject,
			stakingObject,
			upgradeManagerObject: get('upgrade_manager_object'),
			treasuryObject: get('treasury_object'),
			exchangeObject: get('exchange_object'),
		};
		return state;
	});

// -----------------------------------------------------------------------------
// Phase 5: exchange
// -----------------------------------------------------------------------------

export const resolveExchange = (args: {
	/** Supervisor's `Sui.client`. Plumbed through from the walrus
	 *  primitive instead of constructing a fresh `SuiGrpcClient` here so
	 *  there's one chain-talking client per stack (same transport, same
	 *  MVR overrides, same cache state). Phase -1 (gRPC migration)
	 *  collapses the previous independent-`SuiJsonRpcClient` seam. */
	client: SuiGrpcClient;
	walrusPackageId: string;
	exchangeObject: string | undefined;
}): Effect.Effect<ExchangeState | undefined, WalrusError> =>
	Effect.fn('walrus.exchange')(function* () {
		if (args.exchangeObject === undefined) {
			// Deploy ran without `--with-wal-exchange`. Skip silently —
			// seed-account swaps will short-circuit on the same check.
			return undefined;
		}
		const info = yield* Effect.tryPromise({
			try: () => args.client.core.getObject({ objectId: args.exchangeObject! }),
			catch: (cause) => cause,
		}).pipe(
			Effect.map((res) => ({ kind: 'found' as const, info: res })),
			Effect.catch((cause) => {
				// Cache-resume probe: pre-fix a wiped chain made the
				// `getObject` fail loudly, which halted the entire walrus
				// composite. Now we log and return `'missing'` so the
				// caller can degrade gracefully (faucet WAL strategy
				// just doesn't register; downstream WAL funding fails
				// later with a clearer "no WAL strategy" error instead
				// of an inscrutable boot-time exchange-probe failure).
				const message = (cause as { message?: string }).message ?? String(cause);
				if (/not\s*found|does\s*not\s*exist|OBJECT_NOT_FOUND/i.test(message)) {
					return Effect.succeed({ kind: 'missing' as const });
				}
				return Effect.fail(
					new WalrusError({
						phase: 'exchange',
						message: `walrus.exchange: getObject failed: ${stringifyCause(cause)}`,
						cause,
					}),
				);
			}),
		);
		if (info.kind === 'missing') {
			yield* Effect.logWarning(
				`walrus.exchange: cached exchangeObject ${args.exchangeObject} not found on chain — ` +
					`assuming a fresh genesis since the cache was written. WAL faucet wiring skipped this cycle; ` +
					`re-running deploy will mint a new exchange on the next cold path.`,
			);
			return undefined;
		}
		const exchangeType = info.info.object.type;
		const packageId = exchangeType.split('::')[0];
		if (packageId === undefined || !packageId.startsWith('0x')) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'exchange',
					message:
						`walrus.exchange: unexpected exchange object type "${exchangeType}" — ` +
						`expected "<pkg>::wal_exchange::Exchange"`,
				}),
			);
		}
		return {
			objectId: args.exchangeObject,
			packageId,
			walType: `${args.walrusPackageId}::wal::WAL`,
		};
	})();
