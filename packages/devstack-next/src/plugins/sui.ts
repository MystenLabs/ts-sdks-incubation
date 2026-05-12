import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import { dockerContainer } from '../runners/docker-container.js';
import { dockerImage } from '../runners/docker-image.js';
import { dockerNetwork } from '../runners/docker-network.js';
import type { Endpoint } from '../shapes/index.js';

/** In-network alias the sui-localnet container responds to. Sibling
 * containers (walrus deploy + nodes, sui indexer, seal key-server) on
 * the same per-(app, stack) docker network reach the localnet RPC at
 * `sui-localnet:9000` and the faucet at `sui-localnet:9123` instead of
 * threading host-port mappings. */
export const SUI_LOCALNET_NETWORK_ALIAS = 'sui-localnet';

/** In-network alias for the postgres sidecar that backs sui's embedded
 * indexer + GraphQL. Resolvable from the sui-localnet container only —
 * no host port mapping. */
export const SUI_INDEXER_DB_NETWORK_ALIAS = 'sui-indexer-db';

// Postgres connection details. Kept in code (not user-configurable)
// because the database is an internal implementation detail of the sui
// plugin — only the colocated sui process talks to it. Same values the
// old devstack used so cached snapshots interpret matching schemas.
const SUI_INDEXER_DB_IMAGE = 'postgres:16-alpine';
const SUI_INDEXER_DB_USER = 'postgres';
const SUI_INDEXER_DB_PASSWORD = 'devstack';
const SUI_INDEXER_DB_NAME = 'sui_indexer';
const SUI_INDEXER_DATABASE_URL = `postgres://${SUI_INDEXER_DB_USER}:${SUI_INDEXER_DB_PASSWORD}@${SUI_INDEXER_DB_NETWORK_ALIAS}:5432/${SUI_INDEXER_DB_NAME}`;

const exec = promisify(execFile);

// Vendored Dockerfile + entrypoint.sh ship under `src/plugins/sui/docker/`.
// `tsdown.config.ts` mirrors them to `dist/plugins/sui/docker/` so
// `import.meta.url` resolves the same path in source and built outputs.
const DOCKER_CONTEXT = fileURLToPath(new URL('./sui/docker/', import.meta.url));

/** Sui release tag baked into the localnet image. Bump when consumers
 * need a newer binary; the image's content-addressed tag flips
 * automatically (build arg → input hash). */
export const SUI_DEFAULT_VERSION = 'devnet-v1.71.0';

export type SuiNetwork = 'localnet' | 'testnet' | 'mainnet' | 'devnet';

export interface SuiOptions {
	network: SuiNetwork;
	/** Sui release tag, e.g. `'devnet-v1.71.0'`. Becomes a `--build-arg` to
	 * the vendored Dockerfile. Localnet only. */
	version?: string;
	/** Pre-built localnet image. When set, the `sui.image` build is
	 * skipped and the literal tag is used directly. Useful for CI-published
	 * images or when pinning to an upstream sui-tools tag. */
	image?: string;
	/** Override RPC URL — point at an externally-managed sui node instead
	 * of spawning a container. Localnet only (live nets always use this). */
	rpcUrl?: string;
	/** Override faucet URL. Localnet only — live nets resolve from the
	 * network name. */
	faucetUrl?: string;
	/** Container ready-probe timeout. Localnet only. Default 60s. */
	readyTimeoutMs?: number;
}

export interface SuiState {
	rpcUrl: string;
	/** Set on localnet + testnet/devnet; absent on mainnet. */
	faucetUrl?: string;
	/** GraphQL endpoint URL (`http://127.0.0.1:<port>/graphql`). Set on
	 * localnet (sui's embedded indexer + GraphQL fronted by the postgres
	 * sidecar); absent on live nets where GraphQL availability depends on
	 * the public fullnode operator. */
	graphqlUrl?: string;
	network: SuiNetwork;
}

const provides = {
	rpc: dep((s: SuiState) => ({ url: s.rpcUrl })),
	faucet: dep((s: SuiState) => {
		if (s.faucetUrl === undefined) {
			throw new Error(`sui (${s.network}): no faucet on this network`);
		}
		return { url: s.faucetUrl };
	}),
	graphql: dep((s: SuiState) => {
		if (s.graphqlUrl === undefined) {
			throw new Error(`sui (${s.network}): no graphql on this network`);
		}
		return { url: s.graphqlUrl };
	}),
	/** `Endpoint`-shape Dep for the `manifest({ endpoints })` slot.
	 *  Always emits the RPC entry; the faucet + graphql entries are
	 *  exposed separately so apps can opt out of either by not listing
	 *  them in their manifest call. */
	endpoint: dep(
		(s: SuiState): Endpoint => ({ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' }),
	),
	/** Throws on mainnet (no public faucet). */
	faucetEndpoint: dep((s: SuiState): Endpoint => {
		if (s.faucetUrl === undefined) {
			throw new Error(`sui (${s.network}): no faucet on this network`);
		}
		return { name: 'sui-faucet', url: s.faucetUrl, kind: 'faucet' };
	}),
	network: dep((s: SuiState) => s.network),
	full: dep((s: SuiState) => s),
} satisfies Provides<SuiState>;

const PUBLIC_RPC: Record<Exclude<SuiNetwork, 'localnet'>, string> = {
	mainnet: 'https://fullnode.mainnet.sui.io:443',
	testnet: 'https://fullnode.testnet.sui.io:443',
	devnet: 'https://fullnode.devnet.sui.io:443',
};
const PUBLIC_FAUCET: Partial<Record<SuiNetwork, string>> = {
	testnet: 'https://faucet.testnet.sui.io',
	devnet: 'https://faucet.devnet.sui.io',
};

// `sui` schema. `sui.create({ network })` returns a Producer:
//   - localnet → a pure transformer Producer that depends on a private
//     `dockerContainer({...})` node for the actual container lifecycle.
//     Plugin code never calls `docker` directly; the runner handles spawn,
//     ready probing, warm-restart liveness, shutdown registration, and
//     puts a `DockerContainerState`-shaped node into the graph that any
//     snapshot / lifecycle pass can discover uniformly. Consumer URLs
//     resolve to `http://127.0.0.1:<host-port>` from the container's
//     allocated host ports.
//   - testnet/mainnet/devnet → a stub Producer that just publishes the
//     well-known fullnode URL (no Docker, no ports).
//
// Both branches expose the same `provides` (rpc, faucet, network, full)
// so consumer code is network-agnostic. The faucet recipe throws on
// mainnet (no public faucet) — matches the actual capability.
//
// Static use:
//   const cfg = defineDevstackConfig({
//     stack: [
//       sui.create({ network: 'localnet' }),
//       manifest({ endpoints: [sui.get('endpoint-as-shape')] }),
//     ],
//   });
//
// `sui.get('rpc')` returns a static Dep with `__pluginId` — the engine
// resolves it to the running instance at graph build time. No need to
// thread the producer through.
export const sui = defineSchema<SuiOptions, SuiState, typeof provides>({
	id: 'sui',
	provides,
	create: (opts): SchemaInstanceConfig<SuiState, typeof provides, any> => {
		if (opts.network === 'localnet') return localnetInstance(opts);
		return liveInstance(opts);
	},
});

function localnetInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	// Caller provided an external rpcUrl: skip Docker, just publish URLs.
	if (opts.rpcUrl !== undefined) {
		return staticInstance(opts);
	}
	const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
	const version = opts.version ?? SUI_DEFAULT_VERSION;

	// Image: build from the vendored Dockerfile via `dockerImage` unless the
	// caller pinned a pre-built tag. The build runner is content-addressed —
	// a Dockerfile/entrypoint edit or a `version` bump flips the tag, which
	// in turn flips the container's input hash and triggers a recreate.
	const image =
		opts.image !== undefined
			? opts.image
			: dockerImage({
					name: 'sui.image',
					context: { path: DOCKER_CONTEXT },
					args: { SUI_VERSION: version },
				});

	// Postgres sidecar that backs `sui start --with-indexer`'s database.
	// sui's CLI requires a real postgres URL — no embedded option — so
	// we run a `postgres:16-alpine` next to the localnet container on
	// the same per-stack docker network. Only the sui process talks to
	// it (in-network alias `sui-indexer-db`); no host port mapping. Same
	// shape the old devstack used.
	const indexerDb = dockerContainer({
		name: 'sui.indexer-db',
		runsAs: 'sui-indexer-db',
		image: SUI_INDEXER_DB_IMAGE,
		network: dockerNetwork.get('name'),
		networkAlias: SUI_INDEXER_DB_NETWORK_ALIAS,
		containerEnv: {
			POSTGRES_USER: SUI_INDEXER_DB_USER,
			POSTGRES_PASSWORD: SUI_INDEXER_DB_PASSWORD,
			POSTGRES_DB: SUI_INDEXER_DB_NAME,
		},
		readyTimeoutMs: 30_000,
		readyProbe: async ({ containerId }) => {
			try {
				await exec('docker', [
					'exec',
					containerId,
					'pg_isready',
					'-U',
					SUI_INDEXER_DB_USER,
					'-d',
					SUI_INDEXER_DB_NAME,
				]);
				return true;
			} catch {
				return false;
			}
		},
		// Indexer schema + populated indexes live in the postgres data
		// directory inside the writable layer. `quiesce: 'stop'` calls
		// `docker stop` so postgres's WAL flushes cleanly before the
		// commit — `pause` would catch the daemon mid-write. Restore
		// brings the populated schema back so a `snapshot restore`
		// doesn't have to re-index from chain.
		snapshot: { commit: true, quiesce: 'stop' },
	});

	const container = dockerContainer({
		name: 'sui.localnet.container',
		runsAs: 'sui',
		image: typeof image === 'string' ? image : image.get('tag'),
		// Gate sui-localnet's start on the postgres sidecar being live —
		// `--with-indexer` retries internally but only briefly; without
		// the gate, a slow-starting postgres can wedge sui's boot.
		deps: { _indexerDb: indexerDb.get('state') },
		// `sui start` is the modern entrypoint (sui-test-validator is
		// deprecated). The vendored entrypoint.sh handles genesis
		// bootstrap + checkpoint-retention before exec'ing `sui` with
		// these args. `--with-indexer` points at the postgres sidecar
		// via the per-stack network alias; `--with-graphql` runs the
		// embedded GraphQL server on top of the indexer.
		args: [
			'start',
			'--with-faucet=0.0.0.0:9123',
			`--with-indexer=${SUI_INDEXER_DATABASE_URL}`,
			'--with-graphql=0.0.0.0:9125',
		],
		ports: [
			{ slot: 'sui.rpc', containerPort: 9000 },
			{ slot: 'sui.faucet', containerPort: 9123 },
			{ slot: 'sui.graphql', containerPort: 9125 },
		],
		// Join the per-(app, stack) docker network so siblings (walrus
		// deploy + nodes, seal key-server) resolve the localnet at
		// `sui-localnet:9000` instead of host.docker.internal, AND so
		// sui itself reaches the indexer-db via `sui-indexer-db:5432`.
		network: dockerNetwork.get('name'),
		networkAlias: SUI_LOCALNET_NETWORK_ALIAS,
		readyTimeoutMs,
		readyProbe: async ({ hostPorts }) => {
			const rpcPort = hostPorts['sui.rpc'];
			const faucetPort = hostPorts['sui.faucet'];
			if (rpcPort === undefined || faucetPort === undefined) return false;
			// Both must be live before we declare the localnet ready —
			// downstream `accounts.fund` immediately POSTs to the
			// faucet and was failing with `fetch failed` when the RPC
			// came up first and start unblocked too early.
			const rpcOk = await probeSuiRpc(`http://127.0.0.1:${rpcPort}`);
			if (!rpcOk) return false;
			return probeFaucet(`http://127.0.0.1:${faucetPort}`);
		},
		// RocksDB chain state lives in the writable layer. Pause-then-
		// commit captures a consistent flushed snapshot — snapshot
		// restore brings the chain back without re-running genesis or
		// the (much slower) walrus + seal + deepbook publish pipelines.
		snapshot: { commit: true, quiesce: 'pause' },
	});

	return {
		name: 'sui.localnet',
		deps: {
			rpcPort: container.get('hostPort', { slot: 'sui.rpc' }),
			faucetPort: container.get('hostPort', { slot: 'sui.faucet' }),
			graphqlPort: container.get('hostPort', { slot: 'sui.graphql' }),
		},
		start: async ({
			deps: { rpcPort, faucetPort, graphqlPort },
		}): Promise<SuiState> => ({
			rpcUrl: `http://127.0.0.1:${rpcPort}`,
			faucetUrl: `http://127.0.0.1:${faucetPort}`,
			graphqlUrl: `http://127.0.0.1:${graphqlPort}/graphql`,
			network: 'localnet',
		}),
		represents: {
			endpoints: (s: SuiState): Endpoint[] => {
				const out: Endpoint[] = [{ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' }];
				if (s.faucetUrl !== undefined) {
					out.push({ name: 'sui-faucet', url: s.faucetUrl, kind: 'faucet' });
				}
				if (s.graphqlUrl !== undefined) {
					out.push({ name: 'sui-graphql', url: s.graphqlUrl, kind: 'graphql' });
				}
				return out;
			},
		},
	};
}

function liveInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	if (opts.network === 'localnet') {
		throw new Error('liveInstance: not callable with localnet');
	}
	const rpcUrl = opts.rpcUrl ?? PUBLIC_RPC[opts.network];
	const faucetUrl = opts.faucetUrl ?? PUBLIC_FAUCET[opts.network];
	return {
		name: `sui.${opts.network}`,
		start: async (): Promise<SuiState> => {
			const state: SuiState = { rpcUrl, network: opts.network };
			if (faucetUrl !== undefined) state.faucetUrl = faucetUrl;
			return state;
		},
		represents: {
			endpoints: (s: SuiState): Endpoint[] => [{ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' }],
		},
	};
}

function staticInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	const rpcUrl = opts.rpcUrl;
	if (rpcUrl === undefined) throw new Error('staticInstance: rpcUrl is required');
	return {
		name: `sui.${opts.network}`,
		start: async (): Promise<SuiState> => {
			const state: SuiState = { rpcUrl, network: opts.network };
			if (opts.faucetUrl !== undefined) state.faucetUrl = opts.faucetUrl;
			return state;
		},
	};
}

async function probeSuiRpc(rpcUrl: string): Promise<boolean> {
	try {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method: 'sui_getChainIdentifier',
			params: [],
			id: 1,
		});
		const { stdout } = await exec('curl', [
			'-sf',
			'-X',
			'POST',
			'-H',
			'Content-Type: application/json',
			'-d',
			body,
			rpcUrl,
		]);
		return stdout.includes('result');
	} catch {
		return false;
	}
}

// Probes the sui faucet via a `POST /v2/gas` to a synthetic
// 0x0 recipient. Daemon answers with a 4xx (rejected request) only
// once it's listening + parsing JSON; pre-bind the connection
// refuses entirely. `curl -s` (no `-f`) exits 0 on 4xx responses
// but throws on network-level errors.
async function probeFaucet(faucetUrl: string): Promise<boolean> {
	try {
		await exec('curl', [
			'-s',
			'-o',
			'/dev/null',
			'--max-time',
			'2',
			'-X',
			'POST',
			'-H',
			'Content-Type: application/json',
			'-d',
			'{"FixedAmountRequest":{"recipient":"0x0000000000000000000000000000000000000000000000000000000000000000"}}',
			`${faucetUrl}/v2/gas`,
		]);
		return true;
	} catch {
		return false;
	}
}
