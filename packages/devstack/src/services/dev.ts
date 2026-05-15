// Dev(opts) — the user-app dev-server slot. Replaces `hostProcess(...)`
// for the common case of "run my vite/next/whatever server with traefik
// fronting it and a stack-scoped hostname." Power users wanting custom
// command/env/readyProbe combinations can still reach for the lower-
// level `hostProcess` under `advanced.*`.

import { Effect } from 'effect';
import {
	hostProcess,
	type HostProcessOptions,
	type ReadyProbe,
} from '../primitives/host-process.js';
import type { Ref } from '../advanced/tag.js';

export interface DevOptions<E = never, R = never> {
	/** Command to run. */
	readonly command: string;
	/** CLI args. */
	readonly args?: ReadonlyArray<string>;
	/** Preferred host port. Allocated via `PortAllocator` so multiple
	 *  stacks of the same app don't collide. */
	readonly port?: number;
	/** Working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Env vars. Can be a literal record or an `Effect` yielding refs to
	 *  derive env from resolved upstream services (e.g.
	 *  `env: ctx => ({ INDEXER_URL: ctx.refs(indexer).url })`). */
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	/** Ready probe — defaults to HTTP GET on the allocated port. */
	readonly ready?: ReadyProbe;
	/** Refs this dev server depends on (must be acquired first). Accepts
	 *  any Ref or StackMember — the supervisor yields each for ordering. */
	readonly needs?: ReadonlyArray<Ref<any, any, any, any> | { readonly __layer: unknown }>;
	/** Override tag name. Defaults to `'frontend.dev-server'`. */
	readonly name?: string;
}

/** The dev-server factory. Returns a Ref that, once acquired, runs the
 *  command, registers a traefik route for it under `dev.<app>.localhost`,
 *  and publishes the URL into the endpoint registry (`frontend.dev-server`
 *  in the v3 manifest; routed to `app.dev` in v4). */
export const Dev = <E = never, R = never>(opts: DevOptions<E, R>) => {
	const name = opts.name ?? 'frontend.dev-server';
	const hostOpts: HostProcessOptions<string, E, R> = {
		name,
		command: opts.command,
		...(opts.args !== undefined ? { args: opts.args } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.ready !== undefined ? { readyProbe: opts.ready } : {}),
		...(opts.needs !== undefined
			? { dependsOn: opts.needs as ReadonlyArray<Ref<any, any, any, any>> }
			: {}),
		...(opts.port !== undefined ? { port: { preferred: opts.port } } : {}),
		endpoint: { name: 'dev-server', kind: 'dev-server' },
		traefik: { service: 'dev', entrypoint: 'vite' },
	};
	return Object.assign(hostProcess(hostOpts), { __kind: 'app' as const });
};
