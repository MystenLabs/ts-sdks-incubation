// Walrus localnet plugin. Seven actions: `walrus.network` pins a per-stack
// `/24` so siblings coexist; `walrus.build` builds the testbed image with
// matching sui binary baked in; `walrus.deploy` publishes WAL + walrus +
// subsidies packages and writes per-node configs to `<stackDir>/walrus/
// deploy/` (host bind, no named volume); `walrus.node-{0..3}` run storage
// nodes on fixed IPs `10.<octet>.0.10–13` with RocksDB in the container
// writable layer; `walrus.register` reads the deploy outputs and registers
// the WAL coin + nodes in the registry. Mirrors `MystenLabs/walrus/docker/
// local-testbed/` but connects to our multi-arch sui-localnet over the
// per-(app, stack) network instead of the upstream amd64-only sui-tools
// image, and uses host-fs for cross-container coordination so snapshots
// capture it for free.
//
// `node:*` modules load via top-level `await import(...)` so the static
// surface stays browser-safe — see `runtime/hash.ts` for rationale.

import { Transaction } from '@mysten/sui/transactions';

import { buildImage } from '../../actions/build.js';
import { containerService } from '../../actions/container-service.js';
import { service } from '../../actions/service.js';
import { register } from '../../actions/register.js';
import { seed } from '../../actions/seed.js';
import { coinTokens } from '../../registry/coin.js';
import { probeUrl, waitForReachable } from '../../helpers/probe.js';
import { createLocalSuiClient } from '../../helpers/sui-client.js';
import type {
	Action,
	ActionRunContext,
	LocalnetActionRunContext,
	Plugin,
} from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import { defineRegistryKind } from '../../registry/index.js';
import { stackDir } from '../../runtime/active-stack.js';
import { requireLocalnetCtx } from '../../runtime/runtime-helpers.js';
import {
	appNetworkName,
	devstackContainerLabels,
	ensureNetwork,
	hostDockerPlatform,
	imageExists,
	inspectContainer,
	readContainerFile,
	removeContainer,
	runContainer,
	waitForContainerExit,
} from '../../runtime/docker/index.js';
// Internal subnet probe for the walrus committee's fixed-IP testbed —
// imported from the leaf network module so it stays out of the
// `/authoring` plugin surface (no other plugin needs it).
import { dockerNetworkSubnet } from '../../runtime/docker/network.js';
import { SUI_DEFAULT_VERSION } from '../sui/index.js';
import { WALRUS_VERSION, ensureWalrusImage, walrusImageTag } from './build.js';

const [nodeCrypto, nodeFs, nodePath] = await Promise.all([
	import('node:crypto'),
	import('node:fs'),
	import('node:path'),
]);

const DEFAULT_COMMITTEE_SIZE = 4;
const DEFAULT_SHARDS = 100;

/** Deterministic per-(app, stack) octet in [1, 250]. The walrus testbed
 * needs a /24 with predictable IPs for the storage-node committee;
 * using the same `10.0.0.0/24` for every app+stack pair would collide
 * whenever two of them run concurrently (`Pool overlaps with other
 * one on this address space`). Hashing `appName/stack` into the
 * second-octet space gives ~250 per-host slots before any pigeonhole
 * collision; octet 0 is reserved. The deploy script consumes
 * `WALRUS_LISTENING_IPS` (space-separated) so this plugin can pass
 * per-stack IPs through env to the deploy container. */
function walrusOctet(appName: string, stack: string): number {
	let h = 0;
	const s = `${appName}/${stack}`;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) >>> 0;
	}
	return (h % 250) + 1;
}

const walrusSubnet = (octet: number): string => `10.${octet}.0.0/24`;
const walrusNodeIp = (octet: number, idx: number): string => `10.${octet}.0.${10 + idx}`;
const walrusListeningIpList = (octet: number, committeeSize: number): string =>
	Array.from({ length: committeeSize }, (_, i) => walrusNodeIp(octet, i)).join(' ');

/** Public hostname registered on chain for storage node `idx`.
 * `*.localhost` is RFC-6761 reserved and resolves to 127.0.0.1 on every
 * mainstream OS resolver and modern browser, so the same string works
 * from a host browser (→ host port → walrus.proxy → storage node) and
 * from inside the docker network (→ network alias → storage node
 * directly). The walrus.proxy nginx vhost-routes by Host header so a
 * single shared host port serves all N nodes. */
const walrusPublicHost = (idx: number): string => `walrus-node-${idx}.localhost`;
const walrusPublicHostList = (committeeSize: number): string =>
	Array.from({ length: committeeSize }, (_, i) => walrusPublicHost(i)).join(' ');

const deployContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-walrus-deploy`;
const nodeContainerName = (appName: string, stack: string, idx: number): string =>
	`${appName}-${stack}-walrus-node-${idx}`;
const nodeHostname = (idx: number): string => `dryrun-node-${idx}`;

/** Per-stack host path that holds the walrus deploy outputs (yaml configs +
 * the `deploy` summary file). Bind-mounted into the deploy container (rw)
 * and into each storage node (ro). Snapshot host capture covers it
 * automatically because it lives under `<stackDir>`. */
const walrusDeployHostDir = (appDir: string, stack: string): string =>
	nodePath.resolve(stackDir(appDir, stack), 'walrus', 'deploy');

interface WalrusNode {
	name: string;
	hostname: string;
	ip: string;
	/** Public hostname registered in the on-chain Committee. Uses the
	 * `*.localhost` RFC-6761 namespace so the same string resolves to
	 * 127.0.0.1 from a host browser AND to the storage-node container
	 * (via a docker network alias) from inside the docker network. */
	publicHost: string;
	metricsUrl: string;
	/** Storage-node REST API URL — uniform across the host and the
	 * docker network. From the host this hits walrus.proxy on a host
	 * port; from inside docker the same name resolves directly to the
	 * storage-node container. Plain HTTP: we disable node-side TLS via
	 * the deploy-script patch (axum-server 0.8.0 panics on the
	 * self-signed handshake on arm64-darwin). */
	apiUrl: string;
}

const walrusNodes = defineRegistryKind<WalrusNode>('walrus.nodes');

interface WalrusPluginOptions {
	/** Pinned walrus release tag (e.g. `'devnet-v1.48.0'`). Defaults to
	 * the version tracked in `build.ts`. Used both to pull the matching
	 * binary tarball (`walrus`, `walrus-node`) from the GitHub release
	 * AND as the git ref BuildKit fetches matching source from to compile
	 * `walrus-deploy` (the only binary not in the public release). The
	 * sui version baked into the walrus image is derived internally from
	 * `SUI_DEFAULT_VERSION` — apps should keep `sui()` and `walrus()`
	 * pinned consistently (the package ships them aligned by default). */
	version?: string;
	/** Preferred host port for the walrus.proxy nginx sidecar. A single
	 * shared port fronts all N storage nodes via Host-header vhost
	 * routing (`walrus-node-0.localhost`, `walrus-node-1.localhost`, …).
	 * Default 19185; the per-stack port allocator may pick a different
	 * port if 19185 is already in use, in which case the on-chain
	 * Committee URLs reflect whatever the allocator returned. */
	nodePortBase?: number;
	/** Walrus epoch duration. Default `'24h'` so blobs uploaded with the
	 * SDK's `epochs: 1` survive a normal supervisor restart cycle (~30s
	 * to ~5 min). The upstream walrus testbed default is `'2m'`, but
	 * even at that cadence a kill+restart that crosses an epoch
	 * boundary lets the storage nodes garbage-collect the blob before
	 * the developer can re-read it. Pass a shorter value when
	 * exercising epoch-change behavior in tests; pass `'24h'` (or
	 * higher) for normal app development.
	 *
	 * Format: `<N>(s|m|h|d)` — handled by walrus-deploy's CLI flag. */
	epochDuration?: string;
	/** Number of storage nodes in the committee. Default `4`. Each
	 * node binds a fixed IP in the per-stack /24 (10.<octet>.0.10..);
	 * a contiguous range of host ports of the same size is allocated
	 * for browser SDK access via the walrus.proxy nginx sidecar. */
	committeeSize?: number;
	/** Number of storage shards distributed across the committee.
	 * Default `100` — matches the upstream walrus testbed's hardcoded
	 * value, which is what we shipped before this option existed. The
	 * walrus team's procman default is `10`; we keep `100` to avoid a
	 * silent behavior change but expose the knob for tests probing
	 * shard-count edge cases. Must be `>= committeeSize`. */
	shards?: number;
	/** Enable garbage-collection config in each storage-node yaml.
	 * Defaults to `false` (matches production behavior). When `true`,
	 * `deploy.sh` appends:
	 *
	 *     db_config:
	 *       global:
	 *         experimental_use_optimistic_transaction_db: true
	 *     garbage_collection:
	 *       enable_blob_info_cleanup: true
	 *       enable_data_deletion: true
	 *
	 * Useful for blob-cleanup tests; matches the walrus team's `--gc`
	 * flag in their procman config. */
	gc?: boolean;
}

const DEFAULT_NODE_PORT_BASE = 19185;
const DEFAULT_EPOCH_DURATION = '24h';
const proxyContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-walrus-proxy`;

type WalrusProvides =
	| 'walrus.network'
	| 'walrus.build'
	| 'walrus.deploy'
	| 'walrus.proxy'
	| 'walrus.register'
	| 'walrus.seedWal'
	| `walrus.node-${number}`;

export const walrus = (opts: WalrusPluginOptions = {}): Plugin<WalrusProvides> => {
	const version = opts.version ?? WALRUS_VERSION;
	const suiVersion = SUI_DEFAULT_VERSION;
	const imageTag = walrusImageTag(version, suiVersion);
	const platform = hostDockerPlatform();
	const epochDuration = opts.epochDuration ?? DEFAULT_EPOCH_DURATION;
	const committeeSize = opts.committeeSize ?? DEFAULT_COMMITTEE_SIZE;
	const shards = opts.shards ?? DEFAULT_SHARDS;
	const gc = opts.gc ?? false;
	if (committeeSize < 1) {
		throw new Error(`walrus(): committeeSize must be >= 1, got ${committeeSize}`);
	}
	if (shards < committeeSize) {
		throw new Error(`walrus(): shards (${shards}) must be >= committeeSize (${committeeSize})`);
	}
	// `nodePortBase` is a hint to the per-stack allocator. We allocate
	// exactly one port (the shared walrus.proxy port); all storage
	// nodes register the same port on chain via vhost routing on the
	// proxy. Resolved at action-run time via ctx.ports.
	const preferredNodePortBase = opts.nodePortBase ?? DEFAULT_NODE_PORT_BASE;
	const resolveSharedPort = async (ctx: {
		ports: import('../../core/types.js').PortAllocator;
	}): Promise<number> => {
		const ports = await ctx.ports.allocate({
			slot: 'walrus.proxy',
			preferred: preferredNodePortBase,
			count: 1,
		});
		const port = ports[0];
		if (port === undefined) {
			throw new Error('walrus: port allocator returned empty range');
		}
		return port;
	};

	return definePlugin({
		name: 'walrus',
		// Folded into the snapshot id. Bumping `version:` (which derives a
		// new `imageTag`) invalidates the cached snapshot — chain state is
		// captured by sui's container layer; storage-node state is captured
		// by walrus's own. Port-base hint is intentionally NOT included:
		// reshuffling host ports doesn't change on-chain state.
		inputs: { image: imageTag, version },
		actions: () => {
			const actions: Action[] = [];

			actions.push(
				buildImage({
					name: 'network',
					// `app-network` capability — sui.localnet's
					// `needs: ['walrus.app-network:before']` query picks up this
					// provider and orders this action ahead of it.
					provides: { capabilities: ['walrus.app-network'] },
					inputs: {},
					getStatus: async (ctx) => {
						requireLocalnetCtx(ctx, 'walrus');
						const network = appNetworkName(ctx.appName, ctx.stack);
						const subnet = walrusSubnet(walrusOctet(ctx.appName, ctx.stack));
						const probe = await dockerNetworkSubnet(network);
						switch (probe.kind) {
							case 'missing':
								return { ok: false, detail: `${network} not present` };
							case 'no-subnet':
								return { ok: false, detail: `${network} exists but has no IPAM pin` };
							case 'subnet':
								return probe.cidr === subnet
									? { ok: true, detail: `${network} on ${probe.cidr}` }
									: {
											ok: false,
											detail: `${network} pinned at ${probe.cidr}, expected ${subnet}`,
										};
						}
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx, 'walrus');
						const network = appNetworkName(ctx.appName, ctx.stack);
						const subnet = walrusSubnet(walrusOctet(ctx.appName, ctx.stack));
						const probe = await dockerNetworkSubnet(network);
						if (probe.kind === 'subnet' && probe.cidr !== subnet) {
							throw new Error(
								`walrus.network: ${network} already exists pinned at ${probe.cidr} but walrus needs ${subnet} for fixed-IP nodes. Tear down the stack (\`docker network rm ${network}\`) and re-up.`,
							);
						}
						if (probe.kind === 'no-subnet') {
							throw new Error(
								`walrus.network: ${network} already exists with no IPAM pin (sui.localnet may have created it first). Tear down the stack (\`docker network rm ${network}\`) and re-up so walrus.network runs first.`,
							);
						}
						await ensureNetwork({ name: network, subnet });
					},
				}),
			);

			actions.push(
				buildImage({
					name: 'build',
					inputs: { image: imageTag, version, suiVersion, platform },
					getStatus: async () =>
						(await imageExists(imageTag))
							? { ok: true, detail: imageTag }
							: { ok: false, detail: `image ${imageTag} missing` },
					run: async (ctx) => {
						await ensureWalrusImage({ version, suiVersion, appendLog: ctx.appendLog });
					},
				}),
			);

			actions.push(
				// Run-once Service action: the deploy script exits when
				// done; no daemon. `getStatus` checks for the output file
				// the script wrote, so a snapshot-restored stack skips
				// without spinning a fresh container.
				service({
					name: 'deploy',
					needs: ['build', 'sui.localnet'],
					inputs: { image: imageTag, version, epochDuration, committeeSize, shards, gc },
					/** File-based liveness check. The deploy file is the
					 * primary output (snapshot-restored stacks bring it back
					 * without spinning a deploy container). Chain-staleness
					 * detection comes from the `identity` cascade:
					 * `sui.localnet`'s identity is `chainId`, which we fold
					 * into this action's input hash via `needs:`. So a chain
					 * regenesis flips this action's input hash and forces a
					 * re-deploy without any per-action chain probe.
					 */
					getStatus: async (ctx) => {
						const file = nodePath.resolve(walrusDeployHostDir(ctx.appDir, ctx.stack), 'deploy');
						if (!nodeFs.existsSync(file)) {
							return { ok: false, detail: 'deploy outputs not present' };
						}
						try {
							parseDeployFile(nodeFs.readFileSync(file, 'utf8'));
							return { ok: true, detail: 'walrus contracts deployed' };
						} catch (err) {
							return { ok: false, detail: `deploy file unparseable: ${(err as Error).message}` };
						}
					},
					/** Identity = sha256 of the parsed deploy file IDs. Each
					 * `walrus.deploy` cycle rewrites these (fresh package +
					 * object IDs every regen), so any downstream action with
					 * `needs: ['walrus.deploy']` (the four storage nodes,
					 * register, seedWal) cascades-re-runs through input-hash
					 * mismatch — `containerService.run()` then wipes the node
					 * containers' RocksDB writable layers on recreation. */
					identity: async (ctx) => {
						const file = nodePath.resolve(walrusDeployHostDir(ctx.appDir, ctx.stack), 'deploy');
						if (!nodeFs.existsSync(file)) return undefined;
						try {
							const ids = parseDeployFile(nodeFs.readFileSync(file, 'utf8'));
							return nodeCrypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
						} catch {
							return undefined;
						}
					},
					run: async (ctx) => {
						const network = appNetworkName(ctx.appName, ctx.stack);
						const containerName = deployContainerName(ctx.appName, ctx.stack);
						const hostDir = walrusDeployHostDir(ctx.appDir, ctx.stack);
						const sharedPort = await resolveSharedPort(ctx);
						nodeFs.mkdirSync(hostDir, { recursive: true });
						// If a stale container is hanging around (from a prior
						// failed run that didn't auto-rm), remove it before
						// re-running so the docker run name doesn't collide.
						const info = await inspectContainer(containerName);
						if (info !== null) {
							await removeContainer(containerName);
						}
						await runContainer({
							name: containerName,
							image: imageTag,
							platform,
							network,
							hostname: 'walrus-deploy',
							restart: 'no',
							// Env vars consumed by `deploy.sh`:
							//   WALRUS_PUBLIC_HOSTS — space-separated list of
							//     N hostnames; passed to walrus-deploy as
							//     `--host-addresses` and end up as the
							//     on-chain Committee `network_address` for
							//     each node.
							//   WALRUS_LISTENING_IPS — space-separated list
							//     of N internal docker IPs; passed to
							//     `generate-dry-run-configs` as
							//     `--listening-ips` so binding stays on the
							//     docker IP regardless of the public hostname.
							//   WALRUS_REST_API_PORT — single port used both
							//     for `public_port` (on chain) and as the
							//     bind port on each node.
							//   WALRUS_COMMITTEE_SIZE / WALRUS_SHARDS — sizes
							//     forwarded to walrus-deploy; script validates
							//     SHARDS >= COMMITTEE_SIZE.
							//   WALRUS_EPOCH_DURATION — overrides the script's
							//     default 24h. Walrus garbage-collects blobs
							//     whose registered `epochs` window has passed,
							//     so a too-short epoch (upstream's 2m) lets
							//     dev-cycle blobs disappear before the
							//     developer's next read. We default to 24h.
							//   WALRUS_GC — opt-in GC config block.
							env: {
								WALRUS_PUBLIC_HOSTS: walrusPublicHostList(committeeSize),
								WALRUS_LISTENING_IPS: walrusListeningIpList(
									walrusOctet(ctx.appName, ctx.stack),
									committeeSize,
								),
								WALRUS_REST_API_PORT: String(sharedPort),
								WALRUS_COMMITTEE_SIZE: String(committeeSize),
								WALRUS_SHARDS: String(shards),
								WALRUS_EPOCH_DURATION: epochDuration,
								WALRUS_GC: gc ? 'true' : 'false',
							},
							labels: devstackContainerLabels({
								appName: ctx.appName,
								stack: ctx.stack,
								service: 'walrus-deploy',
							}),
							volumes: [`${hostDir}:/opt/walrus/outputs`],
							command: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
						});
						const exitCode = await waitForContainerExit(containerName);
						if (exitCode !== 0) {
							throw new Error(
								`walrus.deploy: container exited with code ${exitCode} — ` +
									`inspect with \`docker logs ${containerName}\``,
							);
						}
						// Outputs are on the host now; the container is dead
						// weight. Drop it so subsequent `docker ps -a` is tidy
						// and a future re-deploy doesn't trip on a stale name.
						await removeContainer(containerName).catch(() => undefined);
					},
				}),
			);

			for (let i = 0; i < committeeSize; i++) {
				const nodeIdx = i;
				actions.push(
					containerService({
						name: `node-${nodeIdx}`,
						needs: ['deploy'],
						inputs: {
							image: imageTag,
							hostname: nodeHostname(nodeIdx),
							publicHost: walrusPublicHost(nodeIdx),
						},
						containerName: (ctx) => nodeContainerName(ctx.appName, ctx.stack, nodeIdx),
						// RocksDB blob store + sync cursor live in the container layer.
						// `stop` (graceful SIGTERM) flushes outstanding write batches —
						// `pause` would risk losing them. commit:true captures the
						// blob state on `devstack snapshot save`.
						snapshot: { commit: true, quiesce: 'stop' },
						spec: (ctx) => {
							const ip = walrusNodeIp(walrusOctet(ctx.appName, ctx.stack), nodeIdx);
							return {
								name: '',
								image: imageTag,
								platform,
								network: appNetworkName(ctx.appName, ctx.stack),
								ip,
								hostname: nodeHostname(nodeIdx),
								// Docker network alias matching the on-chain Committee's
								// `network_address`. From inside the docker network, peer
								// storage nodes resolve `walrus-node-${nodeIdx}.localhost`
								// directly to this container — no proxy hop. From the
								// host, `*.localhost` resolves to 127.0.0.1 (RFC 6761) and
								// hits walrus.proxy on the shared host port instead.
								networkAlias: walrusPublicHost(nodeIdx),
								restart: 'unless-stopped',
								env: { NODE_NAME: nodeHostname(nodeIdx) },
								// No host port mapping — peer-to-peer traffic stays on
								// the docker network. The walrus.proxy nginx sidecar
								// publishes a single shared host port that vhost-routes
								// to the right node's docker IP, so browser SDK clients
								// can reach all N nodes through one publish.
								labels: devstackContainerLabels({
									appName: ctx.appName,
									stack: ctx.stack,
									service: `walrus-node-${nodeIdx}`,
								}),
								// Storage-node RocksDB lives in the container's writable
								// layer (no named volume) — `docker stop`/`start`
								// preserves it; `docker commit` captures it. The deploy
								// configs come from a per-stack host bind mount; the sui
								// binary is baked into the image at /root/sui_bin/sui
								// (no shared sui-bin volume needed). Mount stays `:ro`
								// because the underlying osxfs/gRPC-fuse driver on
								// macOS Docker rejects keystore lock/write operations
								// (`os error 95`/`Operation not supported`) even when
								// the bind is rw — so run-walrus.sh copies the per-node
								// sui keystore + yaml into /root (writable layer) and
								// rewrites both yaml files (the sui wallet yaml AND
								// the walrus-node yaml's `wallet_config` pointer) to
								// reference the copies. See `walrus/build.ts`.
								volumes: [`${walrusDeployHostDir(ctx.appDir, ctx.stack)}:/opt/walrus/outputs:ro`],
								command: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
								healthcheck: {
									// walrus-node binds metrics on :9184 to its testbed IP
									// (not loopback). The check curls its own IP from
									// inside the container; once the initial epoch sync
									// completes the endpoint reliably returns 200.
									test: ['CMD-SHELL', `curl -sf http://${ip}:9184/metrics > /dev/null || exit 1`],
									intervalSeconds: 5,
									timeoutSeconds: 5,
									retries: 60,
									startPeriodSeconds: 30,
								},
							};
						},
					}),
				);
			}

			actions.push(
				containerService({
					name: 'proxy',
					needs: Array.from({ length: committeeSize }, (_, idx) => `node-${idx}`),
					// Preferred port hint goes into inputs; the resolved
					// per-stack port is a runtime detail and shouldn't
					// invalidate the skip predicate when the allocator
					// picks a different one.
					inputs: { preferredNodePortBase },
					containerName: (ctx) => proxyContainerName(ctx.appName, ctx.stack),
					// Stateless nginx; config regenerated from registry on each
					// `up`. Nothing in its writable layer worth committing.
					snapshot: { commit: false, quiesce: 'none' },
					spec: async (ctx) => {
						const sharedPort = await resolveSharedPort(ctx);
						const configPath = writeProxyConfig({
							appDir: ctx.appDir,
							stack: ctx.stack,
							appName: ctx.appName,
							sharedPort,
							committeeSize,
						});
						return {
							name: '',
							image: 'nginx:alpine',
							platform,
							network: appNetworkName(ctx.appName, ctx.stack),
							hostname: 'walrus-proxy',
							restart: 'unless-stopped',
							ports: [{ host: sharedPort, container: sharedPort }],
							labels: devstackContainerLabels({
								appName: ctx.appName,
								stack: ctx.stack,
								service: 'walrus-proxy',
							}),
							volumes: [`${configPath}:/etc/nginx/nginx.conf:ro`],
						};
					},
					probe: async (ctx) => {
						const sharedPort = await resolveSharedPort(ctx);
						// Probe the host-port path with an explicit Host header so
						// nginx's vhost match selects node-0's upstream.
						const ok = await probeUrl(`http://localhost:${sharedPort}/v1/api`, {
							accept: (r) => r.status > 0,
							headers: { Host: walrusPublicHost(0) },
						});
						return ok
							? {
									ok: true,
									detail: `${committeeSize} nodes vhosted on :${sharedPort}`,
								}
							: { ok: false, detail: 'nginx running but node-0 not responding' };
					},
					postStart: async (ctx) => {
						const sharedPort = await resolveSharedPort(ctx);
						await waitForReachable(`http://localhost:${sharedPort}/v1/api`, 30_000, {
							accept: (r) => r.status > 0,
							headers: { Host: walrusPublicHost(0) },
							intervalMs: 500,
						});
					},
				}),
			);

			actions.push(
				register({
					name: 'register',
					needs: ['deploy', 'node-0', 'proxy'],
					inputs: { image: imageTag, version },
					// Republish the cached registry entries on warm-path skips
					// so the dirty bit fires for codegen-style cascades that
					// depend on `packages` / `tokens` / `walrus.nodes` kinds.
					// Same shape as deepbook/pools.ts:republishCachedPools —
					// re-register reads the existing entry and writes it back
					// (no-op on equal values, but signals dirtiness so emits
					// downstream re-fire correctly).
					provides: {
						registry: (ctx) => republishWalrusFromCache(ctx),
					},
					getStatus: async (ctx) => {
						// The deploy volume is the authoritative source of truth: each
						// `walrus.deploy` cycle rewrites `/opt/walrus/outputs/deploy` with
						// fresh package + object IDs. Compare the registry's captured
						// state against that file — a mismatch (chain regenesis, manifest
						// from a previous deploy, etc.) returns ok:false so `run`
						// re-registers with the live IDs.
						requireLocalnetCtx(ctx, 'walrus');
						let deployText: string;
						try {
							deployText = await readContainerFile(
								nodeContainerName(ctx.appName, ctx.stack, 0),
								'/opt/walrus/outputs/deploy',
							);
						} catch {
							return { ok: false, detail: 'deploy file not yet readable' };
						}
						let ids: DeployFileIds;
						try {
							ids = parseDeployFile(deployText);
						} catch {
							return { ok: false, detail: 'deploy file unparseable' };
						}
						const pkg = ctx.registry.packages.find('walrus');
						const wal = coinTokens(ctx.registry).find('wal');
						const nodes = walrusNodes(ctx.registry).list();
						if (
							pkg !== undefined &&
							pkg.packageId === ids.walrusPackageId &&
							pkg.captured?.systemObject === ids.systemObject &&
							pkg.captured?.stakingObject === ids.stakingObject &&
							pkg.captured?.exchangeObject === ids.exchangeObject &&
							wal !== undefined &&
							nodes.length === committeeSize &&
							nodes.every((n) => typeof n.publicHost === 'string')
						) {
							return { ok: true, detail: pkg.packageId };
						}
						return { ok: false, detail: 'walrus registry stale or empty' };
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx, 'walrus');
						const sharedPort = await resolveSharedPort(ctx);
						await registerWalrus(ctx, sharedPort, committeeSize);
					},
					/** Identity = registered walrus packageId. Anything that
					 * needs walrus's package (downstream Move calls, codegen
					 * via `packages` dirty kind, the WAL token consumers)
					 * cascade-re-runs when the deploy moved. */
					identity: async (ctx) => ctx.registry.packages.find('walrus')?.packageId,
				}),
			);

			actions.push(
				seed({
					name: 'seedWal',
					needs: ['register'],
					inputs: { amountSui: SEED_WAL_PAYMENT_SUI.toString() },
					getStatus: async (ctx) => {
						const walType = coinTokens(ctx.registry).find('wal')?.type;
						if (walType === undefined) return { ok: false, detail: 'wal token not registered' };
						const rpcUrl = ctx.registry.services.require('sui-rpc').url;
						const client = createLocalSuiClient(rpcUrl);
						const names = ctx.accounts.names();
						for (const name of names) {
							let signer;
							try {
								signer = ctx.accounts.get(name);
							} catch {
								continue;
							}
							const balance = await client.core.getBalance({
								owner: signer.toSuiAddress(),
								coinType: walType,
							});
							if (BigInt(balance.balance.balance) < SEED_WAL_THRESHOLD) {
								return { ok: false, detail: `${name} below WAL threshold` };
							}
						}
						return { ok: true, detail: `${names.length} accounts funded` };
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx, 'walrus');
						await seedWal(ctx);
					},
				}),
			);

			return actions;
		},
	});
};

const SEED_WAL_PAYMENT_SUI = 1_000_000_000n; // 1 SUI per account → exchange rate determines WAL out
const SEED_WAL_THRESHOLD = 1n; // any positive balance counts as "funded"

interface DeployFileIds {
	walrusPackageId: string;
	systemObject: string;
	stakingObject: string;
	upgradeManagerObject?: string;
	treasuryObject?: string;
	exchangeObject?: string;
}

function parseDeployFile(text: string): DeployFileIds {
	const get = (key: string): string | undefined => {
		const m = text.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
		const value = m?.[1];
		if (value === undefined || value === 'None') return undefined;
		return value;
	};
	const walrusPackageId = get('package_id');
	const systemObject = get('system_object');
	const stakingObject = get('staking_object');
	if (walrusPackageId === undefined || systemObject === undefined || stakingObject === undefined) {
		throw new Error(
			`walrus.register: deploy file missing one of {package_id, system_object, staking_object}:\n${text.slice(0, 400)}`,
		);
	}
	return {
		walrusPackageId,
		systemObject,
		stakingObject,
		upgradeManagerObject: get('upgrade_manager_object'),
		treasuryObject: get('treasury_object'),
		exchangeObject: get('exchange_object'),
	};
}

/**
 * Swap a small amount of SUI for WAL on each devstack-declared account so
 * downstream blob uploads don't require manual `walrus get-wal` calls.
 *
 * The exchange contract address comes from the deployed Exchange object's
 * type — it lives in a separate `wal_exchange` package, not the main
 * walrus package, so we have to query the chain to discover it.
 *
 * Skips accounts whose resolver captured an error (live-net signer
 * misconfigured, etc.) so a partial failure doesn't poison the rest.
 */
async function seedWal(ctx: LocalnetActionRunContext): Promise<void> {
	const walrusPkg = ctx.registry.packages.require('walrus');
	const exchangeId = walrusPkg.captured.exchangeObject;
	if (exchangeId === undefined) {
		throw new Error(
			'walrus.seedWal: exchangeObject missing from captured walrus package state. ' +
				'Did the deploy run with `--with-wal-exchange`?',
		);
	}
	const rpcUrl = ctx.registry.services.require('sui-rpc').url;
	const client = createLocalSuiClient(rpcUrl);
	const objectInfo = await client.core.getObject({ objectId: exchangeId });
	const exchangeType = objectInfo.object.type;
	const exchangePkgId = exchangeType.split('::')[0];
	if (exchangePkgId === undefined || !exchangePkgId.startsWith('0x')) {
		throw new Error(`walrus.seedWal: unexpected exchange type ${exchangeType}`);
	}

	for (const name of ctx.accounts.names()) {
		let signer;
		try {
			signer = ctx.accounts.get(name);
		} catch {
			continue;
		}
		const tx = new Transaction();
		// `useGasCoin: false` so the SDK resolver picks the SUI source
		// itself (address-balance withdrawal preferred over coin
		// objects) — keeps this builder gas-mode-agnostic.
		const paymentCoin = tx.coin({
			balance: SEED_WAL_PAYMENT_SUI,
			type: '0x2::sui::SUI',
			useGasCoin: false,
		});
		const walCoin = tx.moveCall({
			target: `${exchangePkgId}::wal_exchange::exchange_all_for_wal`,
			arguments: [tx.object(exchangeId), paymentCoin],
		});
		tx.transferObjects([walCoin], tx.pure.address(signer.toSuiAddress()));
		const result = await client.signAndExecuteTransaction({
			signer,
			transaction: tx,
			options: { showEffects: true },
		});
		if (result.effects?.status.status !== 'success') {
			throw new Error(
				`walrus.seedWal: failed for ${name}: ${result.effects?.status.error ?? 'unknown'}`,
			);
		}
		await client.waitForTransaction({ digest: result.digest });
	}
}

async function registerWalrus(
	ctx: LocalnetActionRunContext,
	sharedPort: number,
	committeeSize: number,
): Promise<void> {
	const deployText = await readContainerFile(
		nodeContainerName(ctx.appName, ctx.stack, 0),
		'/opt/walrus/outputs/deploy',
	);
	const ids = parseDeployFile(deployText);

	const rpcUrl = ctx.registry.services.require('sui-rpc').url;
	const walCoinType = await fetchWalCoinType(rpcUrl, ids);

	if (walCoinType !== undefined) {
		coinTokens(ctx.registry).register({
			name: 'wal',
			type: walCoinType,
			decimals: 9,
		});
	}

	const captured: Record<string, string> = {
		systemObject: ids.systemObject,
		stakingObject: ids.stakingObject,
	};
	if (ids.upgradeManagerObject !== undefined) {
		captured.upgradeManagerObject = ids.upgradeManagerObject;
	}
	if (ids.treasuryObject !== undefined) captured.treasuryObject = ids.treasuryObject;
	if (ids.exchangeObject !== undefined) captured.exchangeObject = ids.exchangeObject;

	ctx.registry.packages.register({
		name: 'walrus',
		packageId: ids.walrusPackageId,
		captured,
		network: ctx.network,
	});

	const nodes = walrusNodes(ctx.registry);
	const octet = walrusOctet(ctx.appName, ctx.stack);
	for (let i = 0; i < committeeSize; i++) {
		const ip = walrusNodeIp(octet, i);
		const publicHost = walrusPublicHost(i);
		nodes.register({
			name: nodeHostname(i),
			hostname: nodeHostname(i),
			ip,
			publicHost,
			metricsUrl: `http://${ip}:9184/metrics`,
			apiUrl: `http://${publicHost}:${sharedPort}`,
		});
	}
}

/** Re-register cached walrus entries on warm-path skips so the dirty
 * bit fires for downstream Emits (codegen cascades that depend on
 * `packages` / `tokens` / `walrus.nodes`). Mirrors the shape used by
 * deepbook/pools.ts:republishCachedPools — re-registering on equal
 * values is a no-op for the registry's content, but it signals
 * dirtiness so the cascade picks up the entries. */
function republishWalrusFromCache(ctx: ActionRunContext): void {
	const pkg = ctx.registry.packages.find('walrus');
	if (pkg !== undefined) ctx.registry.packages.register(pkg);
	const wal = coinTokens(ctx.registry).find('wal');
	if (wal !== undefined) coinTokens(ctx.registry).register(wal);
	const nodes = walrusNodes(ctx.registry);
	for (const node of nodes.list()) nodes.register(node);
}

/** Pull the WAL coin type out of the chain. The `walrus-deploy` output
 * names a `treasury_object` whose type is `<wal_pkg>::wal::ProtectedTreasury`
 * — same package that owns the `wal::WAL` coin. `system_object` and
 * `staking_object` are walrus-package types without WAL in their generics,
 * so the treasury is the right anchor. Falls back to undefined (rather
 * than throwing) so a degraded chain doesn't take the whole register
 * action down — apps still get `packages.walrus` and node URLs. */
/**
 * Write an nginx config that fronts all N storage nodes on a single
 * shared port using Host-header vhost routing. The on-chain Committee
 * registers each node as `walrus-node-<idx>.localhost:<sharedPort>`,
 * so the same URL works:
 *
 *   - from a host browser: `*.localhost` → 127.0.0.1 (RFC 6761) →
 *     host port → this proxy → vhost match → upstream docker IP.
 *   - from inside docker: a `walrus-node-<idx>.localhost` network
 *     alias on the storage-node container resolves directly without
 *     touching this proxy at all.
 *
 * The config goes into the per-stack `<stackDir>/.generated/` so it
 * tracks the stack lifecycle (new stack → new config; drop stack → file
 * goes away with the rest).
 */
function writeProxyConfig(opts: {
	appDir: string;
	stack: string;
	appName: string;
	sharedPort: number;
	committeeSize: number;
}): string {
	const generatedDir = nodePath.resolve(
		opts.appDir,
		'.devstack',
		'stacks',
		opts.stack,
		'.generated',
	);
	nodeFs.mkdirSync(generatedDir, { recursive: true });
	const configPath = nodePath.resolve(generatedDir, 'walrus-proxy.conf');
	const octet = walrusOctet(opts.appName, opts.stack);
	const servers = Array.from({ length: opts.committeeSize }, (_, idx) => {
		const upstream = walrusNodeIp(octet, idx);
		const serverName = walrusPublicHost(idx);
		// Plain-HTTP upstream: TLS is disabled on each storage node via
		// the deploy-script patch (build.ts) — axum-server 0.8.0 panics
		// on the self-signed handshake on arm64-darwin. The upstream
		// port matches the bind port the nodes are configured for via
		// `--rest-api-port` in deploy.sh.
		return `
server {
	listen 0.0.0.0:${opts.sharedPort};
	server_name ${serverName};
	location / {
		proxy_pass http://${upstream}:${opts.sharedPort};
		proxy_set_header Host $host;
		proxy_request_buffering off;
		proxy_buffering off;
		client_max_body_size 0;
	}
}`;
	}).join('\n');
	const config = `events {}
http {
${servers}
}
`;
	nodeFs.writeFileSync(configPath, config, 'utf8');
	return configPath;
}

async function fetchWalCoinType(rpcUrl: string, ids: DeployFileIds): Promise<string | undefined> {
	if (ids.treasuryObject === undefined) return undefined;
	const type = await fetchObjectType(rpcUrl, ids.treasuryObject);
	if (type === undefined) return undefined;
	const match = type.match(/^(0x[0-9a-f]+)::wal::ProtectedTreasury$/);
	if (!match) return undefined;
	return `${match[1]}::wal::WAL`;
}

async function fetchObjectType(rpcUrl: string, objectId: string): Promise<string | undefined> {
	const client = createLocalSuiClient(rpcUrl);
	try {
		const info = await client.core.getObject({ objectId });
		return info.object.type;
	} catch {
		return undefined;
	}
}
