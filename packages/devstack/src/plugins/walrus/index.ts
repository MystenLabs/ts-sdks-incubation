// Walrus localnet plugin. Owns seven actions:
//
//   walrus.network      — Pins the per-(app, stack) docker network's subnet at 10.0.0.0/24
//                         so the storage nodes' fixed IPs (10.0.0.10–13) land in the right
//                         pool. Declares `provides: ['walrus.app-network']` so the sui plugin's
//                         localnet action (which queries `'app-network:before'`) runs after
//                         this. Without a provider the sui plugin still works — it just
//                         lets docker pick any free pool, which is what single-app stacks
//                         that don't need walrus already do.
//   walrus.build        — Multi-arch build of `dev-examples/walrus-service:<rev>` via
//                         BuildKit's git build-context (no host clone).
//   walrus.deploy       — One-shot container that publishes WAL + walrus + walrus_subsidies
//                         packages, generates per-node configs, then exits(0). Idempotent
//                         via getStatus (`exited(0)` = healthy).
//   walrus.node-{0..3}  — 4 storage nodes on fixed IPs 10.0.0.10–13. Each runs run-walrus.sh,
//                         which faucets SUI from the in-network `sui-localnet` alias, swaps
//                         500 WAL on the exchange, and starts walrus-node.
//   walrus.register     — Reads `/opt/walrus/outputs/deploy` from a node container, queries
//                         the sui chain to extract the WAL coin type, and registers WAL
//                         (tokens), the walrus package (packages), and the 4 nodes
//                         (`registry.ns('walrus').nodes`).
//
// Architecture mirrors `MystenLabs/walrus/docker/local-testbed/` with one
// deliberate divergence: instead of their bundled `mysten/sui-tools:mainnet`
// image (amd64-only → Rosetta on M-series), the deploy + nodes connect to
// our existing devstack-managed multi-arch sui-localnet via the per-(app,
// stack) `<app>-<stack>-net` Docker network and the `sui-localnet` DNS
// alias the sui plugin registers on it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Transaction } from '@mysten/sui/transactions';

import { buildImage } from '../../actions/build.js';
import { containerService } from '../../actions/container-service.js';
import { job } from '../../actions/job.js';
import { register } from '../../actions/register.js';
import { seed } from '../../actions/seed.js';
import { createLocalSuiClient } from '../../helpers/sui-client.js';
import {
	type Action,
	type LocalnetActionRunContext,
	type RegistryQuery,
	requireLocalnetCtx,
} from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import {
	devstackContainerLabels,
	dockerNetworkSubnet,
	ensureNetwork,
	imageExists,
	inspectContainer,
	readContainerFile,
	removeContainer,
	runContainer,
	waitForContainerExit,
} from '../sui/docker.js';
import { appNetworkName } from '../sui/index.js';
import { WALRUS_REV, ensureWalrusImage, hostDockerPlatform, walrusImageTag } from './build.js';

const NODE_COUNT = 4;
const NODE_IPS = ['10.0.0.10', '10.0.0.11', '10.0.0.12', '10.0.0.13'] as const;
const APP_NETWORK_SUBNET = '10.0.0.0/24';

const deployContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-walrus-deploy`;
const nodeContainerName = (appName: string, stack: string, idx: number): string =>
	`${appName}-${stack}-walrus-node-${idx}`;
const nodeHostname = (idx: number): string => `dryrun-node-${idx}`;
const deployOutputsVolume = (appName: string, stack: string): string =>
	`${appName}-${stack}-walrus-deploy-outputs`;
const suiBinVolumeName = (appName: string, stack: string): string => `${appName}-${stack}-sui-bin`;

export interface WalrusNode {
	name: string;
	hostname: string;
	ip: string;
	metricsUrl: string;
	/** Internal docker-network URL (HTTPS, self-signed) — what the on-chain
	 * committee data points at and what nodes use to talk to each other. */
	apiUrl: string;
	/** Host-mapped URL for browser SDK access. The `walrus-node` container's
	 * `9185` is published on `localhost:<nodeHostPortBase + idx>` so the
	 * vite-proxy + SDK fetch override pair can reach it from a browser tab.
	 * Same self-signed cert as `apiUrl`. */
	hostApiUrl: string;
}

export interface WalrusNamespace {
	nodes: RegistryQuery<WalrusNode>;
}

export interface WalrusPluginOptions {
	/** Pinned walrus revision. Defaults to the rev tracked in `build.ts`.
	 * The build helper fetches the walrus repo via a BuildKit git context
	 * and bakes the deploy/run scripts into the resulting image (no host
	 * filesystem cache). */
	rev?: string;
	/** Base host port for storage node REST APIs. Each node's `9185`
	 * (HTTPS sliver/metadata API) is mapped to `nodeHostPortBase + nodeIdx`
	 * — default 19185, so the four nodes land on 19185–19188.
	 *
	 * Browser apps can't reach the storage nodes' internal docker IPs
	 * (`10.0.0.10–13`) directly. `createDevstackWalrusClient()` installs a
	 * fetch override that rewrites the SDK's outbound storage-node URLs to
	 * the host-mapped ports — that's what makes the storage protocol
	 * reachable from a browser tab. */
	nodeHostPortBase?: number;
}

const DEFAULT_NODE_HOST_PORT_BASE = 19185;
const proxyContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-walrus-proxy`;

export const walrus = (opts: WalrusPluginOptions = {}) => {
	const rev = opts.rev ?? WALRUS_REV;
	const imageTag = walrusImageTag(rev);
	const platform = hostDockerPlatform();
	const nodeHostPortBase = opts.nodeHostPortBase ?? DEFAULT_NODE_HOST_PORT_BASE;
	const nodeHostPort = (idx: number): number => nodeHostPortBase + idx;

	return definePlugin({
		name: 'walrus',
		actions: () => {
			const actions: Action[] = [];

			actions.push(
				buildImage({
					name: 'network',
					// `app-network` capability — sui.localnet's
					// `needs: ['walrus.app-network:before']` query picks up this
					// provider and orders this action ahead of it.
					provides: { capabilities: ['walrus.app-network'] },
					inputs: { subnet: APP_NETWORK_SUBNET },
					getStatus: async (ctx) => {
						requireLocalnetCtx(ctx);
						const network = appNetworkName(ctx.appName, ctx.stack);
						const probe = await dockerNetworkSubnet(network);
						switch (probe.kind) {
							case 'missing':
								return { ok: false, detail: `${network} not present` };
							case 'no-subnet':
								return { ok: false, detail: `${network} exists but has no IPAM pin` };
							case 'subnet':
								return probe.cidr === APP_NETWORK_SUBNET
									? { ok: true, detail: `${network} on ${probe.cidr}` }
									: {
											ok: false,
											detail: `${network} pinned at ${probe.cidr}, expected ${APP_NETWORK_SUBNET}`,
										};
						}
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx);
						const network = appNetworkName(ctx.appName, ctx.stack);
						const probe = await dockerNetworkSubnet(network);
						if (probe.kind === 'subnet' && probe.cidr !== APP_NETWORK_SUBNET) {
							throw new Error(
								`walrus.network: ${network} already exists pinned at ${probe.cidr} but walrus needs ${APP_NETWORK_SUBNET} for fixed-IP nodes. Tear down the stack (\`docker network rm ${network}\`) and re-up.`,
							);
						}
						if (probe.kind === 'no-subnet') {
							throw new Error(
								`walrus.network: ${network} already exists with no IPAM pin (sui.localnet may have created it first). Tear down the stack (\`docker network rm ${network}\`) and re-up so walrus.network runs first.`,
							);
						}
						await ensureNetwork({ name: network, subnet: APP_NETWORK_SUBNET });
					},
				}),
			);

			actions.push(
				buildImage({
					name: 'build',
					inputs: { image: imageTag, rev, platform },
					getStatus: async () =>
						(await imageExists(imageTag))
							? { ok: true, detail: imageTag }
							: { ok: false, detail: `image ${imageTag} missing` },
					run: async () => {
						await ensureWalrusImage({ rev });
					},
				}),
			);

			actions.push(
				job({
					name: 'deploy',
					needs: ['build', 'sui.localnet'],
					inputs: { image: imageTag, rev },
					getStatus: async (ctx) => {
						requireLocalnetCtx(ctx);
						const info = await inspectContainer(deployContainerName(ctx.appName, ctx.stack));
						if (info === null) {
							return { ok: false, detail: 'deploy container not yet run' };
						}
						if (info.state === 'exited' && info.exitCode === 0) {
							return { ok: true, detail: 'walrus contracts deployed' };
						}
						if (info.state === 'running') {
							return { ok: false, detail: 'deploy still running' };
						}
						return {
							ok: false,
							detail: `deploy ${info.state}${info.state === 'exited' ? ` (exit ${info.exitCode})` : ''}`,
						};
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx);
						const network = appNetworkName(ctx.appName, ctx.stack);
						const containerName = deployContainerName(ctx.appName, ctx.stack);
						const info = await inspectContainer(containerName);
						if (info?.state === 'exited' && info.exitCode === 0) {
							// Already done — trust the volume.
							return;
						}
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
							labels: devstackContainerLabels({
								appName: ctx.appName,
								stack: ctx.stack,
								service: 'walrus-deploy',
							}),
							volumes: [`${deployOutputsVolume(ctx.appName, ctx.stack)}:/opt/walrus/outputs`],
							command: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
						});
						const exitCode = await waitForContainerExit(containerName);
						if (exitCode !== 0) {
							throw new Error(
								`walrus.deploy: container exited with code ${exitCode} — ` +
									`inspect with \`docker logs ${containerName}\``,
							);
						}
					},
				}),
			);

			for (let i = 0; i < NODE_COUNT; i++) {
				const nodeIdx = i;
				const ip = NODE_IPS[nodeIdx];
				if (ip === undefined) throw new Error(`walrus: missing IP for node ${nodeIdx}`);
				actions.push(
					containerService({
						name: `node-${nodeIdx}`,
						needs: ['deploy'],
						inputs: { image: imageTag, ip, hostname: nodeHostname(nodeIdx) },
						containerName: (ctx) => nodeContainerName(ctx.appName, ctx.stack, nodeIdx),
						spec: (ctx) => {
							requireLocalnetCtx(ctx);
							return {
								name: '',
								image: imageTag,
								platform,
								network: appNetworkName(ctx.appName, ctx.stack),
								ip,
								hostname: nodeHostname(nodeIdx),
								restart: 'unless-stopped',
								env: { NODE_NAME: nodeHostname(nodeIdx) },
								// No host port mapping — walrus-node binds HTTPS with a
								// self-signed cert that browsers refuse to trust. The
								// `walrus.proxy` action below runs an nginx sidecar that
								// terminates the self-signed TLS and re-exposes each node
								// as plain HTTP on a host port — that's what the browser
								// SDK actually talks to.
								labels: devstackContainerLabels({
									appName: ctx.appName,
									stack: ctx.stack,
									service: `walrus-node-${nodeIdx}`,
								}),
								volumes: [
									`${suiBinVolumeName(ctx.appName, ctx.stack)}:/root/sui_bin`,
									`${deployOutputsVolume(ctx.appName, ctx.stack)}:/opt/walrus/outputs`,
								],
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
					needs: NODE_IPS.map((_, idx) => `node-${idx}`),
					inputs: { ports: NODE_IPS.map((_, idx) => nodeHostPort(idx)) },
					containerName: (ctx) => proxyContainerName(ctx.appName, ctx.stack),
					spec: (ctx) => {
						requireLocalnetCtx(ctx);
						const configPath = writeProxyConfig({
							appDir: ctx.appDir,
							stack: ctx.stack,
							ports: NODE_IPS.map((_, idx) => nodeHostPort(idx)),
						});
						return {
							name: '',
							image: 'nginx:alpine',
							platform,
							network: appNetworkName(ctx.appName, ctx.stack),
							hostname: 'walrus-proxy',
							restart: 'unless-stopped',
							ports: NODE_IPS.map((_, idx) => ({
								host: nodeHostPort(idx),
								container: nodeHostPort(idx),
							})),
							labels: devstackContainerLabels({
								appName: ctx.appName,
								stack: ctx.stack,
								service: 'walrus-proxy',
							}),
							volumes: [`${configPath}:/etc/nginx/nginx.conf:ro`],
						};
					},
					probe: async () => {
						const ok = await probeUrl(`http://localhost:${nodeHostPort(0)}/v1/api`);
						return ok
							? {
									ok: true,
									detail: `4 nodes on ${nodeHostPort(0)}-${nodeHostPort(NODE_COUNT - 1)}`,
								}
							: { ok: false, detail: 'nginx running but node-0 not responding' };
					},
					postStart: async () => {
						await waitForReachable(`http://localhost:${nodeHostPort(0)}/v1/api`, 30_000);
					},
				}),
			);

			actions.push(
				register({
					name: 'register',
					needs: ['deploy', 'node-0', 'proxy'],
					inputs: { image: imageTag, rev },
					getStatus: async (ctx) => {
						// The deploy volume is the authoritative source of truth: each
						// `walrus.deploy` cycle rewrites `/opt/walrus/outputs/deploy` with
						// fresh package + object IDs. Compare the registry's captured
						// state against that file — a mismatch (chain regenesis, manifest
						// from a previous deploy, etc.) returns ok:false so `run`
						// re-registers with the live IDs.
						requireLocalnetCtx(ctx);
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
						const ns = ctx.registry.ns<WalrusNamespace>('walrus');
						const pkg = ctx.registry.packages.find('walrus');
						const wal = ctx.registry.tokens.find('wal');
						const nodes = ns.nodes.list();
						if (
							pkg !== undefined &&
							pkg.packageId === ids.walrusPackageId &&
							pkg.captured?.systemObject === ids.systemObject &&
							pkg.captured?.stakingObject === ids.stakingObject &&
							pkg.captured?.exchangeObject === ids.exchangeObject &&
							wal !== undefined &&
							nodes.length === NODE_COUNT &&
							nodes.every((n) => typeof n.hostApiUrl === 'string')
						) {
							return { ok: true, detail: pkg.packageId };
						}
						return { ok: false, detail: 'walrus registry stale or empty' };
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx);
						await registerWalrus(ctx, nodeHostPort);
					},
				}),
			);

			actions.push(
				seed({
					name: 'seedWal',
					needs: ['register'],
					inputs: { amountSui: SEED_WAL_PAYMENT_SUI.toString() },
					getStatus: async (ctx) => {
						requireLocalnetCtx(ctx);
						const walType = ctx.registry.tokens.find('wal')?.type;
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
						requireLocalnetCtx(ctx);
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
		const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(SEED_WAL_PAYMENT_SUI)]);
		if (paymentCoin === undefined) {
			throw new Error('walrus.seedWal: splitCoins returned no result');
		}
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
	nodeHostPort: (idx: number) => number,
): Promise<void> {
	const deployText = await readContainerFile(
		nodeContainerName(ctx.appName, ctx.stack, 0),
		'/opt/walrus/outputs/deploy',
	);
	const ids = parseDeployFile(deployText);

	const rpcUrl = ctx.registry.services.require('sui-rpc').url;
	const walCoinType = await fetchWalCoinType(rpcUrl, ids);

	if (walCoinType !== undefined) {
		ctx.registry.tokens.register({
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

	const ns = ctx.registry.ns<WalrusNamespace>('walrus');
	for (let i = 0; i < NODE_COUNT; i++) {
		const ip = NODE_IPS[i];
		if (ip === undefined) continue;
		ns.nodes.register({
			name: nodeHostname(i),
			hostname: nodeHostname(i),
			ip,
			metricsUrl: `http://${ip}:9184/metrics`,
			apiUrl: `https://${ip}:9185`,
			hostApiUrl: `http://localhost:${nodeHostPort(i)}`,
		});
	}
}

/** Pull the WAL coin type out of the chain. The `walrus-deploy` output
 * names a `treasury_object` whose type is `<wal_pkg>::wal::ProtectedTreasury`
 * — same package that owns the `wal::WAL` coin. `system_object` and
 * `staking_object` are walrus-package types without WAL in their generics,
 * so the treasury is the right anchor. Falls back to undefined (rather
 * than throwing) so a degraded chain doesn't take the whole register
 * action down — apps still get `packages.walrus` and node URLs. */
/**
 * Write an nginx config that terminates the storage nodes' self-signed
 * HTTPS endpoints and re-exposes them as plain HTTP on per-node ports.
 * Browser-side SDK consumers can then talk to `http://localhost:<port>`
 * without TLS gymnastics.
 *
 * The config goes into the per-stack `<stackDir>/.generated/` so it
 * tracks the stack lifecycle (new stack → new config; drop stack → file
 * goes away with the rest).
 */
function writeProxyConfig(opts: { appDir: string; stack: string; ports: number[] }): string {
	const generatedDir = resolve(opts.appDir, '.devstack', 'stacks', opts.stack, '.generated');
	mkdirSync(generatedDir, { recursive: true });
	const configPath = resolve(generatedDir, 'walrus-proxy.conf');
	const servers = opts.ports
		.map((port, idx) => {
			const upstream = NODE_IPS[idx];
			if (upstream === undefined) throw new Error(`writeProxyConfig: missing IP for node ${idx}`);
			// `proxy_ssl_verify off` accepts the self-signed cert. SNI on so
			// the upstream's certificate match doesn't depend on the IP.
			return `
server {
	listen 0.0.0.0:${port};
	location / {
		proxy_pass https://${upstream}:9185;
		proxy_ssl_verify off;
		proxy_ssl_server_name on;
		proxy_set_header Host $host;
		proxy_request_buffering off;
		proxy_buffering off;
		client_max_body_size 0;
	}
}`;
		})
		.join('\n');
	const config = `events {}
http {
${servers}
}
`;
	writeFileSync(configPath, config, 'utf8');
	return configPath;
}

async function probeUrl(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { method: 'GET', redirect: 'manual' });
		return res.status > 0;
	} catch {
		return false;
	}
}

async function waitForReachable(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await probeUrl(url)) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`walrus.daemon: ${url} did not become reachable within ${timeoutMs}ms`);
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
	const body = JSON.stringify({
		jsonrpc: '2.0',
		method: 'sui_getObject',
		params: [objectId, { showType: true }],
		id: 1,
	});
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body,
	});
	if (!res.ok) return undefined;
	const json = (await res.json()) as { result?: { data?: { type?: string }; error?: unknown } };
	return json.result?.data?.type;
}

