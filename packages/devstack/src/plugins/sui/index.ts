// Sui localnet plugin. Three actions: `sui.build` (docker image),
// `sui.localnet` (run container + register services). Chain state
// lives in the container writable layer; snapshots capture via
// `docker commit`. The `-rN` suffix in the image tag bumps manually
// whenever the Dockerfile / entrypoint changes meaningfully. Dockerfile +
// entrypoint sit beside this file, resolved via `import.meta.url`.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImage as buildImageAction } from '../../actions/build.js';
import { containerService } from '../../actions/container-service.js';
import { type Plugin, requireLocalnetCtx } from '../../core/types.js';
import { pollUntilReady } from '../../helpers/poll.js';
import { definePlugin } from '../../plugin.js';
import {
	buildImage as dockerBuildImage,
	devstackContainerLabels,
	dockerRun,
	ensureNetwork,
	imageExists,
	pruneImagesByLabel,
	requireDockerDaemon,
} from './docker.js';
import { probeCheckpointRetention, probeFaucet, probeGraphql, probeRpc } from './health.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOCKER_CONTEXT = HERE;

interface SuiPluginOptions {
	/** Sui release tag, e.g. `'devnet-v1.71.0'`. Becomes a build-arg. */
	version?: string;
	/** Host port for JSON-RPC + gRPC. Default `9000`. */
	rpcPort?: number;
	/** Host port for the faucet. Default `9123`. */
	faucetPort?: number;
	/** Host port for the GraphQL server. Default `9125`. The container
	 * runs sui's embedded indexer + GraphQL alongside JSON-RPC and
	 * faucet so apps can use the GraphQL API without a separate
	 * `sui-graphql-rpc` deployment. */
	graphqlPort?: number;
	/** Pre-built image tag to use instead of building from `dockerContextDir`.
	 * When set, the `sui.build` action becomes a verify-only probe (existence
	 * check) rather than a docker build. Useful when consuming a CI-published
	 * image (`ghcr.io/<org>/sui-localnet:<sha>`) or pinning to an upstream
	 * sui-test-validator image; the resolved tag flows into the snapshot id
	 * so snapshots cached against one image don't restore against another. */
	image?: string;
	/** Override the Docker build-context dir. Default points at the in-tree Dockerfile. */
	dockerContextDir?: string;
	/** RUST_LOG passed to the sui-test-validator process. Default
	 * `'info,sui=info,sui_node=info'`. Set `'debug'` to fire-hose every
	 * subsystem; usually you want a more focused override like
	 * `'info,sui_consensus=debug,sui_storage=debug'`. */
	logLevel?: string;
	/** Extra `--volume` bind mounts attached to the localnet container.
	 * Each entry is a Docker-style `host:container[:ro]` spec. Use sparingly
	 * — chain state lives in the writable layer by design (see the no-volumes
	 * comment in `localnet.run`); these are for ancillary mounts (custom
	 * `fullnode.yaml`, certificates, snapshot-restore scratch). Mounts apply
	 * only to the `sui-localnet` container's create path; existing containers
	 * keep their original mount set until rebuilt. */
	volumes?: string[];
	/** Number of completed epochs of checkpoint history to retain.
	 *
	 * `sui-localnet`'s stock fullnode.yaml ships with `0` (aggressive
	 * pruning, ~10 min of retention) which strands walrus storage nodes
	 * mid-sync. Default here is `2` — at the localnet's default 24h
	 * epoch, that holds 48–72h of history, enough for a multi-day dev
	 * session. Pass `'MAX'` to disable pruning entirely. Pass any other
	 * number to override (e.g. `1` for a tighter ~24h window). */
	epochsToRetain?: number | 'MAX';
}

export const SUI_DEFAULT_VERSION = 'devnet-v1.71.0';

/** Image revision suffix appended to `dev-examples/sui-localnet:<version>`.
 * Bumped whenever the Dockerfile/entrypoint change in a way that requires
 * a fresh build even on the same `SUI_DEFAULT_VERSION`. The CLI snapshot
 * subcommand and the plugin's tag construction both read this — keep it
 * the single source of truth for the `-rN` ratchet. */
export const SUI_IMAGE_REVISION = 'r7';

/** Per-(app, stack) docker network name. Other plugins (walrus, seal) join
 * this network and reach the sui localnet via the `sui-localnet` DNS
 * alias the localnet action registers. The sui plugin creates the
 * network without a subnet preference — when a plugin in the graph
 * needs a deterministic subnet (walrus's testbed pins 10.0.0.10–13 on
 * 10.0.0.0/24), it should declare an action with
 * `provides: ['walrus.app-network']` and call `ensureNetwork({ name, subnet })`
 * first. The `localnet` action below queries `'walrus.app-network:before'` so
 * any provider runs ahead. Without a provider, the sui plugin's call
 * lets docker pick any free pool — so multiple stacks (and multiple
 * apps) coexist on one host. */
export const appNetworkName = (appName: string, stack: string): string => `${appName}-${stack}-net`;
/** Sui localnet container name — same convention as the network. Apps
 * and other plugins import this so docker exec / cleanup commands target
 * the right container for the active stack. */
export const suiContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-sui`;
const SUI_LOCALNET_ALIAS = 'sui-localnet';

/** DNS alias for the postgres sidecar that backs sui's embedded
 * indexer + GraphQL. Resolvable from inside the sui container via
 * Docker's per-network DNS. */
const SUI_INDEXER_DB_ALIAS = 'sui-indexer-db';
/** Postgres image used for the indexer database. The version is folded
 * into the indexer-db action's inputs so a bump invalidates existing
 * containers. */
const POSTGRES_IMAGE = 'postgres:16-alpine';
/** Postgres connection details. Kept in code (not user-configurable)
 * because the database is an internal implementation detail of the
 * sui plugin — only the colocated sui process talks to it. */
const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'devstack';
const POSTGRES_DB = 'sui_indexer';
const SUI_INDEXER_DATABASE_URL = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${SUI_INDEXER_DB_ALIAS}:5432/${POSTGRES_DB}`;
const indexerDbContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-sui-indexer-db`;

export const sui = (
	opts: SuiPluginOptions = {},
): Plugin<'sui.build' | 'sui.indexer-db' | 'sui.localnet'> => {
	const version = opts.version ?? SUI_DEFAULT_VERSION;
	// `rpcPort` / `faucetPort` are now hints to the per-stack port
	// allocator. Resolved at action-run time via `ctx.ports.allocate`;
	// the resolved values aren't part of `inputs` so a port reshuffle
	// doesn't invalidate the action's skip predicate.
	const preferredRpcPort = opts.rpcPort ?? 9000;
	const preferredFaucetPort = opts.faucetPort ?? 9123;
	const preferredGraphqlPort = opts.graphqlPort ?? 9125;
	const contextDir = opts.dockerContextDir ?? DEFAULT_DOCKER_CONTEXT;
	const builtImageTag = `dev-examples/sui-localnet:${version}-${SUI_IMAGE_REVISION}`;
	const imageTag = opts.image ?? builtImageTag;
	const useExternalImage = opts.image !== undefined;
	const epochsToRetain = opts.epochsToRetain ?? 2;
	const logLevel = opts.logLevel ?? 'info,sui=info,sui_node=info';
	const extraVolumes = opts.volumes ?? [];

	const resolvePorts = async (ctx: {
		ports: import('../../core/types.js').PortAllocator;
	}): Promise<{ rpcPort: number; faucetPort: number; graphqlPort: number }> => {
		const [rpcPort] = await ctx.ports.allocate({ slot: 'sui.rpc', preferred: preferredRpcPort });
		const [faucetPort] = await ctx.ports.allocate({
			slot: 'sui.faucet',
			preferred: preferredFaucetPort,
		});
		const [graphqlPort] = await ctx.ports.allocate({
			slot: 'sui.graphql',
			preferred: preferredGraphqlPort,
		});
		return {
			rpcPort: rpcPort as number,
			faucetPort: faucetPort as number,
			graphqlPort: graphqlPort as number,
		};
	};

	return definePlugin({
		name: 'sui',
		// Folded into the snapshot id (`snapshotIdFromConfig`). Bumping
		// `version`, swapping the docker context, or changing
		// `epochsToRetain` invalidates the cached snapshot — anything else
		// affects only chain state, which the snapshot captures verbatim.
		inputs: { image: imageTag, epochsToRetain, logLevel, externalImage: useExternalImage },
		actions: () => [
			buildImageAction({
				name: 'build',
				inputs: {
					image: imageTag,
					version,
					contextDir,
					external: useExternalImage,
				},
				getStatus: async () => {
					const exists = await imageExists(imageTag);
					if (exists) return { ok: true, detail: imageTag };
					if (useExternalImage) {
						// Caller pinned a pre-built tag — `build` is a verify-only
						// probe in this mode, not a docker build. Fail loudly so
						// the operator pulls / repushes their image; running the
						// in-tree build action would clobber the wrong tag.
						return {
							ok: false,
							detail:
								`pre-built image ${imageTag} not found locally — run \`docker pull ${imageTag}\` ` +
								`(or remove the \`sui({ image })\` override to build from \`dockerContextDir\`)`,
						};
					}
					return { ok: false, detail: `image ${imageTag} missing` };
				},
				run: async (ctx) => {
					await requireDockerDaemon();
					if (useExternalImage) {
						// External image: build action is a no-op outside getStatus.
						// `getStatus` already failed if the image isn't local; if we
						// reach `run` it means a transient mismatch; re-check and
						// throw with the same actionable message.
						if (!(await imageExists(imageTag))) {
							throw new Error(
								`sui.build: pre-built image ${imageTag} disappeared between getStatus and run. ` +
									`Pull it (\`docker pull ${imageTag}\`) and retry.`,
							);
						}
						return;
					}
					const log = ctx.appendLog;
					await dockerBuildImage({
						tag: imageTag,
						contextDir,
						buildArgs: { SUI_VERSION: version },
						labels: { 'devstack.cache': 'sui-localnet', 'devstack.rev': version },
						appendLog: log,
					});
					// Drop superseded sui-localnet tags (older `-rN` suffixes,
					// older sui versions). `containerService` already wiped the
					// stale container via the input-hash recreate path before
					// reaching this build, so a tag in active use here is rare.
					await pruneImagesByLabel({
						labels: { 'devstack.cache': 'sui-localnet' },
						keep: [imageTag],
						appendLog: log,
					});
				},
			}),
			containerService({
				// Postgres sidecar that backs `sui start --with-indexer`'s
				// database. sui's CLI requires a real postgres URL — there's
				// no embedded option — so we run a small `postgres:16-alpine`
				// next to the localnet container on the same per-stack
				// docker network. Only the sui process talks to it; no
				// host port mapping. Matches the ts-sdks e2e localnet
				// setup (`packages/sui/test/e2e/utils/globalSetup.ts`).
				name: 'indexer-db',
				needs: ['walrus.app-network:before'],
				inputs: { image: POSTGRES_IMAGE, db: POSTGRES_DB },
				containerName: (ctx) => indexerDbContainerName(ctx.appName, ctx.stack),
				// Postgres data lives in the container's writable layer.
				// On `docker stop` + `start`, the schema and any indexer
				// state survives. `docker rm` resets it — fine, sui
				// rebuilds the indexer state from chain on next start.
				snapshot: { commit: false, quiesce: 'stop' },
				preRun: async (ctx) => {
					await ensureNetwork({ name: appNetworkName(ctx.appName, ctx.stack) });
				},
				provides: {
					registry: (ctx) => {
						ctx.registry.services.register({
							name: 'sui-indexer-db',
							kind: 'sui-indexer-db',
							url: SUI_INDEXER_DATABASE_URL,
							port: 5432,
							endpointLabel: 'Sui indexer postgres (internal)',
						});
					},
				},
				spec: (ctx) => ({
					name: '',
					image: POSTGRES_IMAGE,
					network: appNetworkName(ctx.appName, ctx.stack),
					networkAlias: SUI_INDEXER_DB_ALIAS,
					env: {
						POSTGRES_USER,
						POSTGRES_PASSWORD,
						POSTGRES_DB,
					},
					labels: devstackContainerLabels({
						appName: ctx.appName,
						stack: ctx.stack,
						service: 'sui-indexer-db',
					}),
					restart: 'unless-stopped',
					healthcheck: {
						test: ['CMD-SHELL', `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`],
						intervalSeconds: 2,
						timeoutSeconds: 2,
						retries: 30,
						startPeriodSeconds: 5,
					},
				}),
			}),
			containerService({
				name: 'localnet',
				// `walrus.app-network:before` is a soft capability query — silently
				// drops when walrus isn't loaded. Walrus's
				// network action declares the provider so its subnet pin
				// runs ahead of this docker network ensure. `indexer-db`
				// must be reachable before `--with-indexer=postgres://...`
				// starts dialing during sui boot.
				needs: ['build', 'indexer-db', 'walrus.app-network:before'],
				inputs: {
					image: imageTag,
					// Preferred-port hints (not the resolved values) so port
					// reshuffles don't invalidate the skip predicate.
					rpcPort: preferredRpcPort,
					faucetPort: preferredFaucetPort,
					graphqlPort: preferredGraphqlPort,
				},
				containerName: (ctx) => suiContainerName(ctx.appName, ctx.stack),
				// RocksDB single-writer; cgroup pause is the safe fast
				// quiesce for snapshot capture. Chain state lives in the
				// container's writable layer so commit:true captures it.
				snapshot: { commit: true, quiesce: 'pause' },
				provides: {
					registry: async (ctx) => {
						requireLocalnetCtx(ctx);
						const { rpcPort, faucetPort, graphqlPort } = await resolvePorts(ctx);
						registerServices(ctx, rpcPort, faucetPort, graphqlPort);
					},
				},
				preRun: async (ctx) => {
					await requireDockerDaemon();
					await ensureNetwork({ name: appNetworkName(ctx.appName, ctx.stack) });
				},
				probe: async (ctx, info) => {
					const network = appNetworkName(ctx.appName, ctx.stack);
					if (!(await containerOnNetwork(info.id, network))) {
						return { ok: false, detail: `${info.id} not on ${network}` };
					}
					const { rpcPort } = await resolvePorts(ctx);
					const rpcUrl = `http://127.0.0.1:${rpcPort}`;
					const rpcProbe = await probeRpc(rpcUrl, 1500);
					if (!rpcProbe.ok) {
						return { ok: false, detail: `RPC: ${rpcProbe.detail ?? 'unreachable'}` };
					}
					// Pruning guard. The devstack-managed image's entrypoint disables
					// checkpoint pruning so walrus storage nodes (which sequentially
					// follow the chain via `get_full_checkpoint`) don't fall off the
					// back of the available-checkpoint window. If a custom image or
					// hand-edited fullnode.yaml re-enables pruning, walrus uploads
					// silently break with `400 Bad Request` after a few minutes —
					// fail this status loudly instead.
					const retain = await probeCheckpointRetention(rpcUrl, 1500);
					if (!retain.ok) {
						return {
							ok: false,
							detail: `checkpoint pruning active (${retain.detail ?? 'unknown'}) — walrus will get stuck`,
						};
					}
					return { ok: true, detail: rpcProbe.detail };
				},
				postStart: async (ctx) => {
					const { rpcPort, faucetPort, graphqlPort } = await resolvePorts(ctx);
					await waitForLocalnetServices(ctx, { rpcPort, faucetPort, graphqlPort });
				},
				spec: async (ctx) => {
					const { rpcPort, faucetPort, graphqlPort } = await resolvePorts(ctx);
					return {
						name: '',
						image: imageTag,
						ports: [
							{ host: rpcPort, container: 9000 },
							{ host: faucetPort, container: 9123 },
							{ host: graphqlPort, container: 9125 },
						],
						// Chain state lives in the container's writable layer
						// by design — `docker stop`/`start` preserves it;
						// `docker rm` destroys it (operator should
						// `devstack stack down`, not `docker rm`); snapshots
						// capture it via `docker commit`. `volumes:` here is
						// the user-supplied extra-mount escape hatch (custom
						// fullnode.yaml, certs, snapshot scratch); chain
						// state stays in the writable layer regardless.
						volumes: extraVolumes,
						env: {
							RUST_LOG: logLevel,
							DEVSTACK_SUI_EPOCHS_TO_RETAIN: String(epochsToRetain),
						},
						labels: devstackContainerLabels({
							appName: ctx.appName,
							stack: ctx.stack,
							service: 'sui-localnet',
						}),
						network: appNetworkName(ctx.appName, ctx.stack),
						networkAlias: SUI_LOCALNET_ALIAS,
						restart: 'unless-stopped',
						healthcheck: {
							test: [
								'CMD-SHELL',
								"curl -sf -X POST -H 'Content-Type: application/json' " +
									`-d '{"jsonrpc":"2.0","method":"sui_getChainIdentifier","params":[],"id":1}' ` +
									'http://localhost:9000 || exit 1',
							],
							intervalSeconds: 2,
							timeoutSeconds: 2,
							retries: 60,
							startPeriodSeconds: 5,
						},
						// `--with-indexer=<DATABASE_URL>` points at the postgres
						// sidecar on the per-stack docker network. The
						// indexer connects via the `sui-indexer-db` DNS alias.
						// `--with-graphql=HOST:PORT` runs the GraphQL server
						// on top of that indexer, host-mapped via the port
						// row above so apps on the host can hit it.
						// Available in `sui start` from v1.30+ (this plugin's
						// default is v1.71+, well within range).
						command: [
							'start',
							'--with-faucet=0.0.0.0:9123',
							`--with-indexer=${SUI_INDEXER_DATABASE_URL}`,
							'--with-graphql=0.0.0.0:9125',
						],
					};
				},
				/** chainId is the only thing about sui-localnet that
				 * downstream actions actually depend on. Folding it into
				 * the cascade signal here means a fresh genesis (image
				 * bump, manual `docker rm`, persistent-volume wipe) auto-
				 * invalidates every chain-bound downstream — walrus.deploy,
				 * walrus.register, walrus.node-*, accounts.fund, every
				 * publish, every register — without anyone needing to
				 * write a chain probe by hand. */
				identity: async (ctx) => {
					const { rpcPort } = await resolvePorts(ctx);
					return await fetchChainIdentifier(`http://127.0.0.1:${rpcPort}`);
				},
			}),
		],
	});
};

/** Parallel probe of every URL the localnet container exposes:
 * JSON-RPC, faucet, GraphQL. The three are independent — RPC doesn't
 * block faucet, faucet doesn't block GraphQL — so racing them brings
 * cold-start time down from `sum` to `max`. Each phase emits its own
 * `pollUntilReady` log lines (start, periodic still-waiting,
 * settle), labeled so users can follow which probe is doing what.
 * GraphQL gets the longest ceiling because the embedded indexer's
 * postgres bootstrap + schema migrations dominate. */
async function waitForLocalnetServices(
	ctx: { appendLog: (line: string) => void },
	ports: { rpcPort: number; faucetPort: number; graphqlPort: number },
): Promise<void> {
	const rpcUrl = `http://127.0.0.1:${ports.rpcPort}`;
	const faucetUrl = `http://127.0.0.1:${ports.faucetPort}`;
	// sui's GraphQL serves at `/graphql` — root returns 404. Apps using
	// `SuiGraphQLClient` pass the full path; the probe must hit it too.
	const graphqlUrl = `http://127.0.0.1:${ports.graphqlPort}/graphql`;
	await Promise.all([
		pollUntilReady(ctx, {
			label: `JSON-RPC at ${rpcUrl}`,
			probe: () => probeRpc(rpcUrl, 1500),
			timeoutMs: 60_000,
		}),
		pollUntilReady(ctx, {
			label: `faucet at ${faucetUrl}`,
			probe: () => probeFaucet(faucetUrl, 1500),
			timeoutMs: 30_000,
		}),
		pollUntilReady(ctx, {
			label: `GraphQL at ${graphqlUrl}`,
			probe: () => probeGraphql(graphqlUrl, 2_000),
			timeoutMs: 120_000,
		}),
	]);
}

/** Single getChainIdentifier call against the localnet RPC. Returns the
 * raw 8-hex-char chain id string. Throws on network errors so the
 * reconciler's identity-capture catch keeps the prior value (better than
 * a transient blip wiping the cascade signal). */
async function fetchChainIdentifier(rpcUrl: string): Promise<string> {
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'sui_getChainIdentifier',
			params: [],
			id: 1,
		}),
	});
	if (!res.ok) throw new Error(`sui_getChainIdentifier: HTTP ${res.status}`);
	const json = (await res.json()) as { result?: string };
	const id = json.result;
	if (typeof id !== 'string') throw new Error('sui_getChainIdentifier: missing result');
	return id;
}

function registerServices(
	ctx: { registry: { services: { register: (s: ServiceRecord) => void } } },
	rpcPort: number,
	faucetPort: number,
	graphqlPort: number,
): void {
	const rpcUrl = `http://127.0.0.1:${rpcPort}`;
	const faucetUrl = `http://127.0.0.1:${faucetPort}`;
	const graphqlUrl = `http://127.0.0.1:${graphqlPort}/graphql`;
	// `sui-rpc` is the canonical entry — sui-test-validator serves both
	// JSON-RPC and gRPC on the same port (the SDK negotiates the protocol
	// on the request body), so a separate `sui-grpc` registry entry was
	// noise. Apps that want gRPC point a `SuiGrpcClient` at the `sui-rpc`
	// URL.
	ctx.registry.services.register({
		name: 'sui-rpc',
		kind: 'sui-rpc',
		url: rpcUrl,
		port: rpcPort,
		endpointLabel: 'Sui JSON-RPC + gRPC',
	});
	ctx.registry.services.register({
		name: 'sui-faucet',
		kind: 'sui-faucet',
		url: faucetUrl,
		port: faucetPort,
		endpointLabel: 'Sui faucet',
	});
	ctx.registry.services.register({
		name: 'sui-graphql',
		kind: 'sui-graphql',
		url: graphqlUrl,
		port: graphqlPort,
		endpointLabel: 'Sui GraphQL',
	});
}

interface ServiceRecord {
	name: string;
	kind: string;
	url: string;
	port: number;
	endpointLabel?: string;
}

/** Probe whether `container` is attached to `network`. Used to detect
 * pre-retrofit containers that need recreating with the new network +
 * alias topology. */
async function containerOnNetwork(container: string, network: string): Promise<boolean> {
	const result = await dockerRun({
		command: [
			'container',
			'inspect',
			container,
			'--format',
			'{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}',
		],
	});
	if (result.code !== 0) return false;
	return result.stdout.trim().split(/\s+/).includes(network);
}
