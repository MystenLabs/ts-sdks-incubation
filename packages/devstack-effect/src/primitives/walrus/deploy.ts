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
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import * as Docker from '../../internal/docker.js';
import { rewriteToHostGateway } from '../../internal/host-gateway.js';
import { stringifyCause } from '../../internal/stringify-cause.js';
import { WalrusError } from '../errors.js';
import type { DeployState, ExchangeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';

// -----------------------------------------------------------------------------
// Phase 2: deploy
// -----------------------------------------------------------------------------

export const deployContracts = (args: {
	name: string;
	image: string;
	rpcUrl: string;
	faucetUrl: string | undefined;
	nodeCount: number;
	shards: number;
	epochDuration: string;
	containerApiPort: number;
	outputDir: string;
	subnetPrefix: string;
}): Effect.Effect<
	DeployState,
	WalrusError,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.fn('walrus.deploy')(function* () {
		const fs = yield* FileSystem.FileSystem;

		// Carve out a host directory for the deploy outputs. Bind-mounted
		// into the deploy one-shot (rw) and the storage node containers
		// (ro). Lives under `<cwd>/.devstack/walrus/<name>/deploy` rather
		// than v3's per-stack path — devstack-effect has no env-aware
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

		// Translate the host-side sui rpc / faucet URLs into addresses
		// reachable from inside the deploy container. `Docker.run` now
		// wires `host.docker.internal:host-gateway` for us; the deploy
		// one-shot inherits the same default via `Docker.runOneShot`.
		// `rewriteToHostGateway` runs through `new URL(...).toString()`
		// which re-adds a trailing `/` on a path-less base — strip it
		// before appending the `/gas` suffix below so we don't end up
		// hitting `host.docker.internal:9123//gas` (404).
		const stripTrailingSlash = (u: string): string => (u.endsWith('/') ? u.slice(0, -1) : u);
		const inNetworkRpc = stripTrailingSlash(rewriteToHostGateway(args.rpcUrl));
		const inNetworkFaucet = stripTrailingSlash(
			args.faucetUrl !== undefined ? rewriteToHostGateway(args.faucetUrl) : inNetworkRpc,
		);

		const publicHosts = Array.from(
			{ length: args.nodeCount },
			(_, i) => `walrus-node-${i}.localhost`,
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
		const env: Record<string, string> = {
			WALRUS_PUBLIC_HOSTS: publicHosts,
			WALRUS_LISTENING_IPS: listeningIps,
			WALRUS_REST_API_PORT: String(args.containerApiPort),
			WALRUS_COMMITTEE_SIZE: String(args.nodeCount),
			WALRUS_SHARDS: String(args.shards),
			WALRUS_EPOCH_DURATION: args.epochDuration,
			WALRUS_NETWORK: `${inNetworkRpc};${inNetworkFaucet}/gas`,
		};

		const result = yield* Docker.runOneShot({
			name: `walrus-${args.name}-deploy`,
			image: args.image,
			env,
			mounts: [{ host: outputDir, container: '/opt/walrus/outputs' }],
			args: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
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
	rpcUrl: string;
	walrusPackageId: string;
	exchangeObject: string | undefined;
}): Effect.Effect<ExchangeState | undefined, WalrusError> =>
	Effect.fn('walrus.exchange')(function* () {
		if (args.exchangeObject === undefined) {
			// Deploy ran without `--with-wal-exchange`. Skip silently —
			// seed-account swaps will short-circuit on the same check.
			return undefined;
		}
		const client = new SuiJsonRpcClient({ url: args.rpcUrl, network: 'localnet' });
		const info = yield* Effect.tryPromise({
			try: () => client.core.getObject({ objectId: args.exchangeObject! }),
			catch: (cause) =>
				new WalrusError({
					phase: 'exchange',
					message: `walrus.exchange: getObject failed: ${stringifyCause(cause)}`,
					cause,
				}),
		});
		const exchangeType = info.object.type;
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
