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

import { buildImage } from '../../actions/build.js';
import { register } from '../../actions/register.js';
import { service } from '../../actions/service.js';
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
	stopContainer,
	waitForContainerExit,
	waitForHealthy,
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
	apiUrl: string;
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
}

export const walrus = (opts: WalrusPluginOptions = {}) => {
	const rev = opts.rev ?? WALRUS_REV;
	const imageTag = walrusImageTag(rev);
	const platform = hostDockerPlatform();

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
					provides: ['walrus.app-network'],
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
				service({
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
					service({
						name: `node-${nodeIdx}`,
						needs: ['deploy'],
						inputs: { image: imageTag, ip, hostname: nodeHostname(nodeIdx) },
						getStatus: async (ctx) => {
							requireLocalnetCtx(ctx);
							const info = await inspectContainer(
								nodeContainerName(ctx.appName, ctx.stack, nodeIdx),
							);
							if (info === null) return { ok: false, detail: 'not present' };
							if (!info.running) return { ok: false, detail: info.state };
							if (info.healthy === true) return { ok: true, detail: `healthy on ${ip}:9184` };
							return { ok: false, detail: `${info.state} (health: ${healthLabel(info.healthy)})` };
						},
						run: async (ctx) => {
							requireLocalnetCtx(ctx);
							const containerName = nodeContainerName(ctx.appName, ctx.stack, nodeIdx);
							const network = appNetworkName(ctx.appName, ctx.stack);
							ctx.onShutdown?.(async () => {
								const live = await inspectContainer(containerName);
								if (live?.running === true) await stopContainer(containerName);
							});
							const info = await inspectContainer(containerName);
							if (info?.running && info.healthy === true) return;
							if (info !== null) await removeContainer(containerName);
							await runContainer({
								name: containerName,
								image: imageTag,
								platform,
								network,
								ip,
								hostname: nodeHostname(nodeIdx),
								restart: 'unless-stopped',
								env: { NODE_NAME: nodeHostname(nodeIdx) },
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
							});
							await waitForHealthy(containerName, { timeoutMs: 5 * 60_000 });
						},
					}),
				);
			}

			actions.push(
				register({
					name: 'register',
					needs: ['deploy', 'node-0'],
					inputs: { image: imageTag, rev },
					getStatus: async (ctx) => {
						// Cheap path: registry already populated from a prior cycle.
						const ns = ctx.registry.ns<WalrusNamespace>('walrus');
						const pkg = ctx.registry.packages.find('walrus');
						const wal = ctx.registry.tokens.find('wal');
						if (pkg !== undefined && wal !== undefined && ns.nodes.list().length === NODE_COUNT) {
							return { ok: true, detail: pkg.packageId };
						}
						return { ok: false, detail: 'walrus registry not yet populated' };
					},
					run: async (ctx) => {
						requireLocalnetCtx(ctx);
						await registerWalrus(ctx);
					},
				}),
			);

			return actions;
		},
	});
};

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

async function registerWalrus(ctx: LocalnetActionRunContext): Promise<void> {
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
			apiUrl: `http://${ip}:9185`,
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

function healthLabel(h: boolean | undefined): string {
	if (h === true) return 'healthy';
	if (h === false) return 'unhealthy';
	return 'no probe';
}
