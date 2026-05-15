// Walrus phase 4 — storage-node committee.
//
// N detached containers, each on a pinned in-network IP. No per-node
// host port any more: each node carries a traefik label set so the
// shared `devstack-router` exposes it on the well-known walrus
// entrypoint port (9185) via the stack-scoped hostname the deploy
// phase registered on chain.
//
// Span: `walrus.nodes` (preserved).

import { Effect } from 'effect';
import * as Docker from '../../engine/docker.js';
import { EngineHandle } from '../../engine/engine.js';
import type { IdentityShape } from '../../engine/identity.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import { WalrusError } from '../../engine/errors.js';
import type { NodeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';

// Per-line sink: tag each line with the storage-node label so the
// TUI tail makes attribution obvious. No-op when no engine is wired
// into the context (standalone callers / tests).
const makeNodeOutputSink = (
	label: string,
): Effect.Effect<Docker.OutputLineCallback> =>
	Effect.gen(function* () {
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		return (level, line) =>
			engineOpt._tag === 'None'
				? Effect.void
				: engineOpt.value
						.appendLog({ ts: Date.now(), level, message: `[${label}] ${line}` })
						.pipe(Effect.ignore);
	});

export const startStorageNodes = (args: {
	name: string;
	image: string;
	nodeCount: number;
	containerApiPort: number;
	routerEntrypointPort: number;
	readyTimeoutMs: number;
	deployDir: string;
	network: string;
	/**
	 * Per-stack sui docker network the storage nodes attach to as a
	 * secondary network so docker DNS resolves `sui-localnet`. The
	 * primary network (`args.network`) keeps the pinned IPs walrus
	 * requires; this additional attachment is what gives the node's
	 * `WALRUS_FAUCET_URL` a working hostname. Undefined when sui is
	 * an externally-managed RPC with no in-network alias.
	 */
	suiNetwork: string | undefined;
	subnetPrefix: string;
	identity: IdentityShape;
	faucetUrl: string;
}) =>
	Effect.fn('walrus.nodes')(function* () {
		const nodes: Array<NodeState> = [];
		for (let i = 0; i < args.nodeCount; i++) {
			const containerIp = `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`;
			const containerName = `walrus-${args.name}-node-${i}`;
			const nodeHostname = `dryrun-node-${i}`;
			const publicHostname = routerHostname(args.identity, `walrus-node-${i}`);
			const onOutputLine = yield* makeNodeOutputSink(`walrus.node-${i}`);

			// Container readiness is probed in-network (we exec `wget` /
			// `nc` into the container) instead of via a host port —
			// nothing on the host loopback maps to this storage node any
			// more. The router binds 9185 once on the host and routes
			// by `Host:` header.
			//
			// Network attach is multi-step: the primary network is
			// `args.network` (walrus-net, where the pinned `--ip` lives);
			// after `docker run` returns, the container additionally
			// joins `devstack-router` (via `traefik:` materializer) AND
			// `args.suiNetwork` (via `Docker.networkConnect` below) so
			// the in-container `WALRUS_FAUCET_URL` (`http://sui-localnet
			// :9123/v1/gas`) resolves via docker DNS.
			const runResult = yield* Docker.run({
				name: containerName,
				image: args.image,
				args: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
				mounts: [{ host: args.deployDir, container: '/opt/walrus/outputs' }],
				// `--hostname` so the container's actual hostname matches
				// the chain-registered name. `WALRUS_FAUCET_URL` is the
				// docker-DNS sui-localnet faucet URL (see
				// `walrus/internal.ts` for the URL assembly).
				env: { HOSTNAME: nodeHostname, WALRUS_FAUCET_URL: args.faucetUrl },
				network: args.network,
				ip: containerIp,
				hostname: nodeHostname,
				networkAlias: `walrus-node-${i}.localhost`,
				detach: true,
				// Per-node traefik router entry. `id` is
				// `<app>-<stack>-walrus-node-N`; `hostname` is the
				// stack-scoped hostname the deploy phase registered on
				// chain; `entrypoint: walrus` resolves to the well-known
				// 9185 port (see `ROUTER_ENTRYPOINTS`); `servicePort` is
				// the in-container port the storage node binds on.
				traefik: [
					{
						id: routerId(args.identity, `walrus-node-${i}`),
						hostname: publicHostname,
						entrypoint: 'walrus',
						servicePort: args.containerApiPort,
						// Walrus storage-node REST API doesn't emit CORS
						// headers. v3 setup relied on the now-deleted
						// nginx walrus-proxy to inject them; here, route
						// through the global `devstack-cors` middleware
						// so browser-side blob fetches from vite work.
						cors: true,
					},
				],
				// Stream the storage node's docker-logs to the supervisor
				// for the lifetime of the reuseScope. Useful for diagnosing
				// peer-config / WAL-fund mishaps that surface as recurring
				// log lines rather than container exits.
				onOutputLine,
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: failed to start storage node ${i}: ${cause.message}`,
							cause,
						}),
					),
				),
			);

			// Dual-home onto the per-stack sui network so docker DNS
			// resolves `sui-localnet` for the storage node's faucet
			// dialer. Skipped when sui is externally managed (no
			// docker-side network to join).
			if (args.suiNetwork !== undefined) {
				yield* Docker.networkConnect(args.suiNetwork, runResult.containerId).pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.fail(
							new WalrusError({
								phase: 'nodes',
								message: `walrus.nodes: failed to attach storage node ${i} to sui network '${args.suiNetwork}': ${cause.message}`,
								cause,
							}),
						),
					),
				);
			}

			// Router-fronted ready probe. Dial the public hostname (which
			// resolves to 127.0.0.1) on the well-known walrus
			// entrypoint port (9185); traefik forwards to this node by
			// `Host:` header. Proves both that the router has indexed
			// the container's labels AND that the storage node is
			// serving — no host-port mapping required. Races against
			// `docker wait` so a crashed node surfaces its stderr
			// rather than timing out blind.
			yield* Docker.awaitContainerReady({
				containerName,
				probe: {
					kind: 'tcp',
					host: publicHostname,
					port: args.routerEntrypointPort,
					timeoutMs: args.readyTimeoutMs,
				},
			}).pipe(
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: storage node ${i} never became ready: ${cause.message}`,
							stderr: cause.detail,
							cause,
						}),
					),
				),
			);

			nodes.push({
				index: i,
				containerIp,
				// Router-fronted URL on the well-known walrus entrypoint
				// port (9185). The SDK and any host process dialing the
				// storage node lands here; traefik forwards to the
				// per-stack container by `Host:` header.
				rpcUrl: `http://${publicHostname}:${args.routerEntrypointPort}`,
				publicHostname,
			});
		}
		return nodes;
	})();
