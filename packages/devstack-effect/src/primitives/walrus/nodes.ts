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
import * as Docker from '../../internal/docker.js';
import type { IdentityShape } from '../../internal/identity.js';
import { routerHostname, routerId } from '../../internal/router-hostname.js';
import { WalrusError } from '../errors.js';
import type { NodeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';

export const startStorageNodes = (args: {
	name: string;
	image: string;
	nodeCount: number;
	containerApiPort: number;
	routerEntrypointPort: number;
	readyTimeoutMs: number;
	deployDir: string;
	network: string;
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

			// Container readiness is probed in-network (we exec `wget` /
			// `nc` into the container) instead of via a host port —
			// nothing on the host loopback maps to this storage node any
			// more. The router binds 9185 once on the host and routes
			// by `Host:` header.
			yield* Docker.run({
				name: containerName,
				image: args.image,
				args: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
				mounts: [{ host: args.deployDir, container: '/opt/walrus/outputs' }],
				// `--hostname` so the container's actual hostname matches
				// the chain-registered name. `WALRUS_FAUCET_URL` keeps
				// the host-gateway sui-faucet rewrite from v3.
				env: { HOSTNAME: nodeHostname, WALRUS_FAUCET_URL: args.faucetUrl },
				network: args.network,
				ip: containerIp,
				hostname: nodeHostname,
				networkAlias: `walrus-node-${i}.localhost`,
				detach: true,
				// Storage nodes dial the sui faucet at the routed URL
				// (`http://faucet.<app>.localhost:9123`) via
				// `WALRUS_FAUCET_URL` — RFC 6761 `.localhost` resolution
				// only works on the host OS, so the container needs
				// explicit `/etc/hosts` entries pointing the routed
				// hostnames at traefik.
				routerAddHosts: true,
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
					},
				],
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
