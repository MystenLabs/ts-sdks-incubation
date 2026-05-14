// Walrus phase 6 — nginx proxy.
//
// Single nginx in front of the committee, vhost-routed by Host header
// so SDK clients keyed on `walrus-node-N.localhost:9185` (browsers
// resolve `*.localhost` to 127.0.0.1) land on the right upstream. The
// proxy joins the shared docker network, so upstreams resolve directly
// to each node's pinned IP — no host gateway round-trip.
//
// Span: `walrus.proxy` (preserved).

import { Effect, FileSystem } from 'effect';
import * as Docker from '../../internal/docker.js';
import { stringifyCause } from '../../internal/stringify-cause.js';
import { WalrusError } from '../errors.js';
import type { NodeState } from './internal.js';

// nginx tag used to front the storage-node committee. Held to a small
// pinned alpine variant so cold-pull latency is bounded.
const PROXY_IMAGE = 'nginx:alpine';

export const startProxy = (args: {
	name: string;
	nodes: ReadonlyArray<NodeState>;
	proxyPort: number;
	containerApiPort: number;
	network: string;
}) =>
	Effect.fn('walrus.proxy')(function* () {
		if (args.nodes.length === 0) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'proxy',
					message: 'walrus.proxy: at least one storage node is required',
				}),
			);
		}
		const fs = yield* FileSystem.FileSystem;

		// nginx config: one server block per node, vhost-routed by Host
		// header. Now that the proxy joins the shared docker network,
		// upstreams resolve directly to each node's pinned IP — no host
		// gateway round-trip needed.
		const config = renderProxyConfig({
			nodes: args.nodes,
			proxyContainerPort: args.proxyPort,
			containerApiPort: args.containerApiPort,
		});
		const configDir = `${process.cwd()}/.devstack/walrus/${args.name}/proxy`;
		const configPath = `${configDir}/nginx.conf`;
		yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: could not prep config dir: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);
		yield* fs.writeFileString(configPath, config).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: could not write nginx.conf: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);

		const containerName = `walrus-${args.name}-proxy`;
		yield* Docker.run({
			name: containerName,
			image: PROXY_IMAGE,
			ports: { [args.proxyPort]: args.proxyPort },
			mounts: [{ host: configPath, container: '/etc/nginx/nginx.conf' }],
			network: args.network,
			detach: true,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: failed to start nginx: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		yield* Docker.awaitContainerReady({
			containerName,
			probe: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: args.proxyPort,
				timeoutMs: 30_000,
			},
		}).pipe(
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: nginx never became ready: ${cause.message}`,
						stderr: cause.detail,
						cause,
					}),
				),
			),
		);

		return `http://127.0.0.1:${args.proxyPort}`;
	})();

// nginx config renderer — single port, N vhosts keyed on Host header.
// Upstreams resolve to the per-node pinned IP on the shared docker
// network, hitting the container's API port directly (no host port
// indirection inside the network).
//
// CORS: walrus storage nodes don't set CORS headers themselves, so a
// browser at `http://localhost:5173-5180` (the dev-server slot range)
// reaching `http://walrus-node-N.localhost:9185` gets blocked at the
// preflight. The proxy injects permissive CORS headers and short-
// circuits OPTIONS with a 204 — only the localhost dev-server is on
// the wire here, and an explicit allowlist would have to enumerate
// every example's vite port (and any user-pinned port too), so we
// reflect the request `Origin` instead. Same posture the seal-key-
// server sets internally.
const renderProxyConfig = (opts: {
	nodes: ReadonlyArray<NodeState>;
	proxyContainerPort: number;
	containerApiPort: number;
}): string => {
	const sortedNodes = [...opts.nodes].sort((a, b) => a.index - b.index);
	const servers = sortedNodes
		.map((node) => {
			const upstream = `http://${node.containerIp}:${opts.containerApiPort}`;
			const serverName = `walrus-node-${node.index}.localhost`;
			return `	server {
		listen 0.0.0.0:${opts.proxyContainerPort};
		server_name ${serverName};
		location / {
			# Walrus storage nodes already send a permissive
			# \`Access-Control-Allow-Origin: *\` themselves. If we also
			# add one, the browser sees two values and rejects with
			# "header contains multiple values". Strip the upstream
			# CORS headers, then inject the policy we want.
			proxy_hide_header Access-Control-Allow-Origin;
			proxy_hide_header Access-Control-Allow-Methods;
			proxy_hide_header Access-Control-Allow-Headers;
			proxy_hide_header Access-Control-Expose-Headers;
			proxy_hide_header Access-Control-Allow-Credentials;
			if ($request_method = OPTIONS) {
				add_header Access-Control-Allow-Origin $http_origin always;
				add_header Access-Control-Allow-Methods 'GET,POST,PUT,DELETE,PATCH,OPTIONS' always;
				add_header Access-Control-Allow-Headers $http_access_control_request_headers always;
				add_header Access-Control-Max-Age 86400 always;
				add_header Content-Length 0 always;
				return 204;
			}
			add_header Access-Control-Allow-Origin $http_origin always;
			add_header Access-Control-Expose-Headers '*' always;
			proxy_pass ${upstream};
			proxy_set_header Host $host;
			proxy_request_buffering off;
			proxy_buffering off;
			client_max_body_size 0;
		}
	}`;
		})
		.join('\n');
	return `events {}
http {
${servers}
}
`;
};
