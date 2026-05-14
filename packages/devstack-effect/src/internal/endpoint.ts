// Generic network endpoint with separate host-side and container-side
// addresses.
//
// The two forms exist because devstack containers reach each other very
// differently depending on whose process is doing the dialling:
//
//   - Host callers (browser, supervisor, vite dev-server, host-side
//     `sui` CLI invocations) need the stack-disambiguating hostnames
//     traefik routes — `sui.<app>.localhost:9000`, `wallet.<app>.localhost:5180`,
//     etc. — so two stacks of the same app coexist on the same well-
//     known ports without colliding.
//   - Container callers can't use those URLs. glibc-based containers
//     hardcode `.localhost → 127.0.0.1` per RFC 6761 and ignore
//     `/etc/hosts` overrides, so a storage node that dials
//     `http://sui.<app>.localhost:9000` resolves to its own loopback
//     and times out. The fix: have containers join the same per-stack
//     docker network as the producing container and dial the docker-DNS
//     alias (`sui-localnet`) instead. Docker resolves that alias to the
//     producing container's intra-network IP, giving the same cross-
//     stack isolation for free (each stack has its own per-stack
//     network).
//
// Producers (the sui primitive, future walrus / seal services that gain
// their own routed surfaces) populate both forms. Consumers pick based
// on where THEY are running:
//
//   - manifest writer / browser-facing endpoint records → `.host`
//   - container env vars / in-container config files →
//     `.container`, plus an attach to one of `.containerNetworks`
//   - code that runs in either context (test helpers) →
//     `endpointUrl(e, 'auto')` returns `.container` if defined else
//     `.host`.

/**
 * A network endpoint that can be reached two different ways: from the
 * host OS and from inside a docker container that joins one of
 * `containerNetworks`.
 *
 * `host` is always defined. `container` is undefined for endpoints
 * with no docker-side address (testnet/mainnet RPC, external services).
 * `containerNetworks` lists docker networks on which `container`
 * resolves — consumer containers must attach to one of these.
 */
export interface Endpoint {
	/**
	 * URL reachable from the host. For routed services this is the
	 * `.<service>.<app>.localhost:<entrypoint-port>` URL traefik
	 * dispatches; for live-net handles it's the upstream public URL.
	 * Always defined.
	 */
	readonly host: string;
	/**
	 * URL reachable from inside a container that joins one of
	 * `containerNetworks`. Undefined for endpoints with no docker-side
	 * address (live-net RPC, externally-managed services without a
	 * docker presence in our network).
	 */
	readonly container?: string;
	/**
	 * Docker networks on which `container` resolves. Consumer containers
	 * must attach to one of these (commonly via `Docker.networkConnect`
	 * after `Docker.run` so they keep their primary network too).
	 * Undefined when `container` is undefined.
	 */
	readonly containerNetworks?: ReadonlyArray<string>;
}

/**
 * Pick the right URL for the calling context.
 *
 *   - `'host'`      → `.host`.
 *   - `'container'` → `.container` (throws when undefined — call only
 *                     from container-side code paths that have already
 *                     decided to attach to one of `.containerNetworks`).
 *   - `'auto'`      → `.container` when defined, else `.host`. Useful
 *                     for code that runs in either context (test
 *                     helpers, ad-hoc tools).
 */
export const endpointUrl = (
	e: Endpoint,
	ctx: 'host' | 'container' | 'auto',
): string => {
	if (ctx === 'host') return e.host;
	if (ctx === 'container') {
		if (e.container === undefined) {
			throw new Error(
				'endpoint has no container-side URL (e.g. live-net RPC); use host or check beforehand',
			);
		}
		return e.container;
	}
	return e.container ?? e.host;
};
