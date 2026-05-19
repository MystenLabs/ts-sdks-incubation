// Dev(opts) — the user-app dev-server slot. Replaces `hostProcess(...)`
// for the common case of "run my vite/next/whatever server with traefik
// fronting it and a stack-scoped hostname." Power users wanting custom
// command/env/readyProbe combinations can still reach for the lower-
// level `hostProcess` under `advanced.*`.
//
// Port handling:
//   - `port:` is the PREFERRED public port. `PortAllocator` reserves it
//     (scanning forward if a sibling stack already bound it), exposes the
//     actual allocated port as `$PORT` in the spawned env, and templates
//     `{port}` placeholders inside `command` / `args` with the allocated
//     value. The default `ready:` URL derives from the allocated port
//     too, so a single port: line cascades through command/env/probe and
//     multiple stacks boot side-by-side without collisions.
//   - User-supplied `env.PORT` wins over the allocator's value (escape
//     hatch for tools that need a different bind port).

import { Effect } from 'effect';
import { hostProcess, type HostProcessOptions, type ReadyProbe } from './dev/internal.js';
import type { LayeredTag } from '../advanced/tag.js';
import { makeService } from '../advanced/make-service.js';
import { EndpointName } from '../runtime/endpoint-names.js';

export interface DevOptions<E = never, R = never> {
	/** Command to run. `{port}` placeholders are substituted with the
	 *  allocator-resolved port (only when `port:` is set). */
	readonly command: string;
	/** CLI args. Each element supports `{port}` placeholder substitution
	 *  (only when `port:` is set). Use this instead of duplicating the
	 *  port number in the command — `args: ['--port', '{port}']` always
	 *  matches whichever port the allocator actually reserved. */
	readonly args?: ReadonlyArray<string>;
	/** Preferred public host port. Allocated via `PortAllocator` so
	 *  multiple stacks of the same app don't collide. The allocated value
	 *  is exposed as `$PORT` and substituted into `{port}` placeholders
	 *  in `command` / `args` / `ready.url`. Defaults the `ready:` probe to
	 *  an HTTP GET on `http://localhost:<allocatedPort>` when no probe is
	 *  supplied. */
	readonly port?: number;
	/** Working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Env vars. Can be a literal record or an `Effect` yielding refs to
	 *  derive env from resolved upstream services (e.g.
	 *  `env: ctx => ({ INDEXER_URL: ctx.refs(indexer).url })`). */
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	/** Ready probe — defaults to HTTP GET on the allocated port when
	 *  `port:` is set. HTTP probe URLs support `{port}` substitution. */
	readonly ready?: ReadyProbe;
	/** Refs this dev server depends on (must be acquired first). Accepts
	 *  any LayeredTag or StackMember — the supervisor yields each for ordering. */
	readonly needs?: ReadonlyArray<LayeredTag<any, any, any, any> | { readonly __layer: unknown }>;
	/** Override tag name. Defaults to `'frontend.dev-server'`. */
	readonly name?: string;
}

const PORT_TEMPLATE = /\{port\}/g;

const renderTemplate = (value: string, port: number): string =>
	value.replace(PORT_TEMPLATE, String(port));

/** Substitute `{port}` placeholders in a ready probe's URL. Other probe
 *  shapes (`log`, `tcp`) don't carry a templatable URL field, so pass
 *  through unchanged. */
const renderReadyProbe = (probe: ReadyProbe, port: number): ReadyProbe => {
	if (probe.kind !== 'http') return probe;
	if (!PORT_TEMPLATE.test(probe.url)) return probe;
	return { ...probe, url: renderTemplate(probe.url, port) };
};

/** The dev-server factory. Returns a LayeredTag that, once acquired, runs the
 *  command, registers a traefik route for it under `dev.<app>.localhost`,
 *  and publishes the URL into the endpoint registry. */
export const Dev = <E = never, R = never>(opts: DevOptions<E, R>) => {
	const name = opts.name ?? EndpointName.DEV_SERVER_PRIMARY;

	// When `port:` is set, templates in `command` / `args` / `ready.url`
	// substitute against the allocator-resolved port. We don't know the
	// allocated port at factory-construction time (it depends on sibling
	// stacks), so we defer the substitution to `hostProcess`'s own port
	// hook via the `portTemplate` field (added on the internal layer).
	const hostOpts: HostProcessOptions<string, E, R> = {
		name,
		command: opts.command,
		...(opts.args !== undefined ? { args: opts.args } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.ready !== undefined ? { readyProbe: opts.ready } : {}),
		...(opts.needs !== undefined
			? { dependsOn: opts.needs as ReadonlyArray<LayeredTag<any, any, any, any>> }
			: {}),
		...(opts.port !== undefined
			? {
					port: { preferred: opts.port },
					portTemplate: {
						renderArg: renderTemplate,
						renderCommand: renderTemplate,
						renderReady: renderReadyProbe,
					},
				}
			: {}),
		// Publish under the PRIMARY name — `frontend.dev-server`. The
		// runtime grouper (`runtime/service.ts::groupApp`) reads PRIMARY
		// only; an older FALLBACK alias (`dev-server`) is gone (Wave 6 §8.6).
		endpoint: { name: EndpointName.DEV_SERVER_PRIMARY, kind: 'dev-server' },
		traefik: { service: 'dev', entrypoint: 'vite' },
	};
	return makeService('dev', 'app', hostProcess(hostOpts));
};
