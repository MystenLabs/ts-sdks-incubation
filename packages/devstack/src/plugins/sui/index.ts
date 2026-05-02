// Sui localnet plugin. Owns three actions:
//
//   sui.build     — Build the `dev-examples/sui-localnet:<version>-r2` image
//                   from the in-tree Dockerfile. Skip when the tag already
//                   exists in the local Docker daemon.
//   sui.localnet  — Run the container detached, wait for JSON-RPC to come
//                   up, register `sui-rpc` / `sui-faucet` / `sui-grpc`
//                   services in the registry. Skip when the named container
//                   is already running and healthy (containers persist
//                   across `up` invocations by design — §9.4).
//   sui.accounts  — For each name in `ctx.accounts.names()`: pull the
//                   resolver-materialized `Signer` (localnet path:
//                   `generatedKeypair()` loads-or-creates the on-disk key
//                   under `<appDir>/.devstack/stacks/<stack>/.keys/`),
//                   fund the address via the faucet if below `minBalance`,
//                   register in the `accounts` kind. Skip when every
//                   account is already at-or-above `minBalance`.
//
// The `-rN` image-tag suffix is bumped manually when the Dockerfile or
// entrypoint changes meaningfully so existing local images get rebuilt on
// next `devstack up`. `-r4` switched from ephemeral `--force-regenesis` to
// persistent genesis (one-shot `sui genesis -f` bootstrap; `sui start`
// resumes from /root/.sui/sui_config on subsequent starts) so chain state
// survives `docker stop` + `docker start` for stack-level resumability.
// `-r5` patches the generated fullnode.yaml to disable checkpoint pruning
// (`num-epochs-to-retain: u64::MAX`) so walrus storage nodes — which
// follow the chain sequentially via `get_full_checkpoint` — don't fall
// off the back of the available-checkpoint window on a long-running stack.
// `-r6` makes that retention bounded + configurable: the entrypoint reads
// `DEVSTACK_SUI_EPOCHS_TO_RETAIN` (default `2` ≈ 48–72h on a default-24h
// epoch, set via the plugin's `epochsToRetain` option) and rewrites both
// `num-epochs-to-retain` + `num-epochs-to-retain-for-checkpoints` on every
// start, so changing the option takes effect without dropping the stack.
// `-r7` drops the sui-bin shared volume export. Chain state lives in
// the container's writable layer (no `:/root/.sui` volume mount) — `docker
// stop` + `docker start` preserves it, `docker rm` destroys it (matches
// the rest of the stack: state is disposable, snapshotted via `docker
// commit`). The walrus image now bakes its own sui binary at build time
// so storage nodes don't need the cross-container volume mount either.
//
// Dockerfile + entrypoint live alongside this file under
// `packages/devstack/src/plugins/sui/`; resolved relative to this module
// via import.meta.url.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImage as buildImageAction } from '../../actions/build.js';
import { register } from '../../actions/register.js';
import { service } from '../../actions/service.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import {
	buildImage as dockerBuildImage,
	devstackContainerLabels,
	dockerRun,
	ensureNetwork,
	imageExists,
	inspectContainer,
	removeContainer,
	runContainer,
	startContainer,
	stopContainer,
} from './docker.js';
import {
	probeCheckpointRetention,
	probeFaucet,
	probeRpc,
	waitForFaucet,
	waitForRpc,
} from './health.js';
import { ensureFunded } from './keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOCKER_CONTEXT = HERE;

export interface SuiPluginOptions {
	/** Sui release tag, e.g. `'devnet-v1.71.0'`. Becomes a build-arg. */
	version?: string;
	/** Host port for JSON-RPC + gRPC. Default `9000`. */
	rpcPort?: number;
	/** Host port for the faucet. Default `9123`. */
	faucetPort?: number;
	/** Override the Docker build-context dir. Default points at the in-tree Dockerfile. */
	dockerContextDir?: string;
	/** Override the per-account minimum balance (MIST). Default 50 SUI. */
	minBalance?: bigint;
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

export const sui = (opts: SuiPluginOptions = {}) => {
	const version = opts.version ?? SUI_DEFAULT_VERSION;
	const rpcPort = opts.rpcPort ?? 9000;
	const faucetPort = opts.faucetPort ?? 9123;
	const contextDir = opts.dockerContextDir ?? DEFAULT_DOCKER_CONTEXT;
	const imageTag = `dev-examples/sui-localnet:${version}-r7`;
	const epochsToRetain = opts.epochsToRetain ?? 2;
	const minBalance = opts.minBalance;

	return definePlugin({
		name: 'sui',
		actions: () => [
			buildImageAction({
				name: 'build',
				inputs: {
					image: imageTag,
					version,
					contextDir,
				},
				getStatus: async () => {
					const exists = await imageExists(imageTag);
					return exists
						? { ok: true, detail: imageTag }
						: { ok: false, detail: `image ${imageTag} missing` };
				},
				run: async () => {
					await dockerBuildImage({
						tag: imageTag,
						contextDir,
						buildArgs: { SUI_VERSION: version },
						labels: { 'devstack.cache': 'sui-localnet', 'devstack.rev': version },
					});
				},
			}),
			service({
				name: 'localnet',
				// `walrus.app-network:before` is a soft capability query — silently
				// drops when walrus isn't loaded. Walrus's
				// network action declares the provider so its subnet pin
				// runs ahead of this docker network ensure.
				needs: ['build', 'walrus.app-network:before'],
				provides: {
					// Reconciler invokes this on every successful path (cold run +
					// warm-path skip), so the in-memory registry is populated
					// regardless of whether `run` executed this cycle.
					registry: (ctx) => {
						requireLocalnetCtx(ctx);
						registerServices(ctx, rpcPort, faucetPort);
					},
				},
				inputs: {
					image: imageTag,
					rpcPort,
					faucetPort,
				},
				getStatus: async (ctx) => {
					requireLocalnetCtx(ctx);
					const containerName = suiContainerName(ctx.appName, ctx.stack);
					const info = await inspectContainer(containerName);
					if (info === null) {
						return { ok: false, detail: `${containerName} not present` };
					}
					if (!info.running) return { ok: false, detail: `${containerName} stopped` };
					const network = appNetworkName(ctx.appName, ctx.stack);
					if (!(await containerOnNetwork(containerName, network))) {
						return { ok: false, detail: `${containerName} not on ${network}` };
					}
					const rpcUrl = `http://127.0.0.1:${rpcPort}`;
					const probe = await probeRpc(rpcUrl, 1500);
					if (!probe.ok) return { ok: false, detail: `RPC: ${probe.detail ?? 'unreachable'}` };
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
					return { ok: true, detail: probe.detail };
				},
				run: async (ctx) => {
					requireLocalnetCtx(ctx);
					const containerName = suiContainerName(ctx.appName, ctx.stack);
					const network = appNetworkName(ctx.appName, ctx.stack);
					await ensureNetwork({ name: network });
					const info = await inspectContainer(containerName);
					const onNetwork = info !== null && (await containerOnNetwork(containerName, network));
					const imageMatches = info !== null && info.image === imageTag;
					// Resume path: container exists, stopped, on the right
					// network, AND was created from the current image tag →
					// `docker start` preserves the persistent chain state in
					// /root/.sui/sui_config (entrypoint resumes via `sui start`
					// without --force-regenesis).
					if (info !== null && !info.running && onNetwork && imageMatches) {
						await startContainer(containerName);
						await waitForRpc(`http://127.0.0.1:${rpcPort}`, { timeoutMs: 60_000 });
						await waitForFaucet(`http://127.0.0.1:${faucetPort}`, { timeoutMs: 30_000 });
						return;
					}
					if (info !== null && (!onNetwork || !imageMatches)) {
						// Container exists but is stale (wrong network, or built
						// from an outdated image tag — usually a devstack upgrade).
						// Remove + recreate; entrypoint's idempotent genesis path
						// preserves the volume's chain state on the rebuild.
						await removeContainer(containerName);
					}
					const stillUsable = info?.running === true && onNetwork && imageMatches;
					// Stop the container on supervisor shutdown (Ctrl-C, `q`
					// keystroke). Volumes persist — the next `up` cycle
					// detects the stopped container + matching image and
					// resumes via the `startContainer` path above. Without
					// this, sui keeps running detached after the supervisor
					// exits, which surprises users who typed Ctrl-C.
					ctx.onShutdown?.(async () => {
						const live = await inspectContainer(containerName);
						if (live?.running === true) await stopContainer(containerName);
					});
					if (!stillUsable) {
						await runContainer({
							name: containerName,
							image: imageTag,
							ports: [
								{ host: rpcPort, container: 9000 },
								{ host: faucetPort, container: 9123 },
							],
							// No volumes — chain state lives in the container's
							// writable layer. `docker stop` + `docker start`
							// preserves it; `docker rm` destroys it (operator
							// should `devstack stack down`, not `docker rm`).
							// Snapshots capture state via `docker commit` (PR 3).
							env: {
								RUST_LOG: 'info,sui=info,sui_node=info',
								DEVSTACK_SUI_EPOCHS_TO_RETAIN: String(epochsToRetain),
							},
							labels: devstackContainerLabels({
								appName: ctx.appName,
								stack: ctx.stack,
								service: 'sui-localnet',
							}),
							network,
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
							command: ['start', '--with-faucet=0.0.0.0:9123'],
						});
					}
					await waitForRpc(`http://127.0.0.1:${rpcPort}`, { timeoutMs: 60_000 });
					// Faucet starts a beat after JSON-RPC; wait so downstream
					// Register actions don't race the first request.
					await waitForFaucet(`http://127.0.0.1:${faucetPort}`, { timeoutMs: 30_000 });
				},
			}),
			register({
				name: 'accounts',
				needs: ['localnet'],
				provides: {
					// Reconciler invokes this on every successful path (cold run +
					// warm-path skip), so the in-memory accounts registry is
					// populated regardless of whether `run` executed this cycle.
					// Only reached when `getStatus.ok` (every account funded), so
					// the addresses we re-publish here are known-good.
					registry: (ctx) => {
						for (const name of ctx.accounts.names()) {
							const signer = ctx.accounts.get(name);
							ctx.registry.accounts.register({
								name,
								address: signer.toSuiAddress(),
								role: name === 'publisher' ? 'publisher' : undefined,
								funded: true,
							});
						}
					},
				},
				inputs: {
					minBalance: minBalance?.toString(),
				},
				getStatus: async (ctx) => {
					const names = ctx.accounts.names();
					if (names.length === 0) return { ok: true, detail: 'no accounts declared' };
					const rpcUrl = `http://127.0.0.1:${rpcPort}`;
					const faucetProbe = await probeFaucet(`http://127.0.0.1:${faucetPort}`);
					if (!faucetProbe.ok) {
						return { ok: false, detail: `faucet: ${faucetProbe.detail ?? 'unreachable'}` };
					}
					// Cheap path: if every account is at-or-above minBalance the
					// reconciler skips `run` and `provides.registry` repopulates
					// the registry. `ctx.accounts.get` rethrows any captured
					// factory error per-account, so a misconfigured live-net
					// signer surfaces with the captured cause.
					for (const name of names) {
						try {
							const signer = ctx.accounts.get(name);
							const address = signer.toSuiAddress();
							await ensureFunded({
								faucetUrl: `http://127.0.0.1:${faucetPort}`,
								rpcUrl,
								address,
								minBalance,
							});
						} catch {
							return { ok: false, detail: `account '${name}' not ready` };
						}
					}
					return { ok: true, detail: `${names.length} account(s) funded` };
				},
				run: async (ctx) => {
					const rpcUrl = `http://127.0.0.1:${rpcPort}`;
					for (const name of ctx.accounts.names()) {
						const signer = ctx.accounts.get(name);
						const address = signer.toSuiAddress();
						await ensureFunded({
							faucetUrl: `http://127.0.0.1:${faucetPort}`,
							rpcUrl,
							address,
							minBalance,
						});
					}
				},
			}),
		],
	});
};

function registerServices(
	ctx: { registry: { services: { register: (s: ServiceRecord) => void } } },
	rpcPort: number,
	faucetPort: number,
): void {
	const rpcUrl = `http://127.0.0.1:${rpcPort}`;
	const faucetUrl = `http://127.0.0.1:${faucetPort}`;
	ctx.registry.services.register({
		name: 'sui-rpc',
		kind: 'sui-rpc',
		url: rpcUrl,
		port: rpcPort,
		endpointLabel: 'Sui JSON-RPC',
	});
	ctx.registry.services.register({
		name: 'sui-grpc',
		kind: 'sui-grpc',
		url: rpcUrl,
		port: rpcPort,
		endpointLabel: 'Sui gRPC (sui.rpc.v2.LedgerService)',
	});
	ctx.registry.services.register({
		name: 'sui-faucet',
		kind: 'sui-faucet',
		url: faucetUrl,
		port: faucetPort,
		endpointLabel: 'Sui faucet',
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
