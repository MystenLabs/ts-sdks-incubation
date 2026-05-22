// Routable capability contract (architecture §4).
//
// Lets the router orchestrator dispatch traffic to a plugin's network
// endpoint(s). Plugin declares endpoints; router mints hostnames
// from `(app, stack, dispatch-id)` and writes file-provider dispatch
// files atomically. No service hostnames hardcoded in router code.
//
// Two wire-protocol families participate:
//
//   - HTTP (`http`, `h2c`) — Host-header dispatch on a SHARED host
//     port. One Traefik HTTP entrypoint can fan out to N backends in
//     parallel stacks via `Host: <service>.<stack>.<app>.localhost`.
//     CORS toggle is meaningful (browser-callable).
//
//   - TCP (`tcp`) — non-HTTP protocols (postgres, redis, mongo, …).
//     Traefik's TCP routers dispatch by entrypoint *port*, NOT by
//     Host: header (TCP has no virtual-host concept). Each TCP backend
//     therefore needs an exclusive entrypoint port. CORS is meaningless
//     (HTTP-only concern).
//
// The two variants are discriminated by `wireProtocol`. We use a
// discriminated-union shape so callers and the router's renderer pick
// the right code path with the type system's help — `cors` is absent
// on TCP and `wireProtocol: 'tcp'` is the discriminator.

/** A plugin-provided dispatch identity. The router combines this with
 *  the runtime identity `(app, stack)` before minting the file-provider
 *  id, so the dispatch id itself does not need to encode app/stack. */
export interface DispatchId {
	readonly compositeKey: string;
	readonly role: string;
}

/** Upstream target registry. Module augmentation can add router-owned
 *  target types without widening the built-in payloads. */
export interface DevstackRoutableUpstreamRegistry {
	readonly container: { readonly containerName: string; readonly containerPort: number };
	readonly 'host-loopback': { readonly port: number };
}

export type RoutableUpstreamKind = keyof DevstackRoutableUpstreamRegistry & string;

/** Upstream target type. Built-ins are container-on-router-network and
 *  host-process-on-loopback. The router resolves URL. */
export type RoutableUpstream<
	Kind extends string = RoutableUpstreamKind,
> = string extends Kind
	? {
			readonly [K in RoutableUpstreamKind]: Readonly<
				{ readonly type: K } & DevstackRoutableUpstreamRegistry[K]
			>;
		}[RoutableUpstreamKind]
	: Kind extends RoutableUpstreamKind
		? Readonly<{ readonly type: Kind } & DevstackRoutableUpstreamRegistry[Kind]>
		: Readonly<{ readonly type: Kind } & object>;

/** Shared fields across both wire-protocol variants. */
interface RoutableBase {
	readonly kind: 'routable';
	readonly endpointName: string;
	readonly dispatchId: DispatchId;
	readonly upstream: RoutableUpstream;
}

/** HTTP variant — Host-header dispatched, CORS-aware. `wireProtocol`
 *  omitted defaults to `'http'` for back-compat with pre-TCP callers. */
export interface RoutableHttpDecl extends RoutableBase {
	readonly wireProtocol?: 'http' | 'h2c';
	readonly cors: boolean;
}

/** TCP variant — entrypoint-port dispatched, no Host header, no CORS.
 *  Each TCP backend MUST reference an entrypoint whose protocol is
 *  `'tcp'` in the registry; parallel stacks of TCP backends cannot
 *  share one entrypoint port (TCP has no virtual-host fan-out). */
export interface RoutableTcpDecl extends RoutableBase {
	readonly wireProtocol: 'tcp';
}

/** Routable declaration. Plugin emits one per endpoint it serves. */
export type RoutableDecl = RoutableHttpDecl | RoutableTcpDecl;
