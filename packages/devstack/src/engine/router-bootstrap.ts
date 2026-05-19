// Shared traefik-router boot helper used by both the long-running
// supervisor (`runDevstack` / `devstack up`) and the one-shot `devstack
// apply` path. Centralising the wrapping (10s timeout + warn-fallback +
// `DEVSTACK_NO_ROUTER` opt-out) prevents the two call sites from
// drifting — pre-extraction, `apply` skipped the ensure-router step
// entirely, which meant fresh CI runners (no pre-existing
// `devstack-router` docker network from a developer's prior `devstack
// up`) failed `docker network connect devstack-router` deep inside the
// per-primitive Docker.run wiring, then sui-localnet's ready-probe timed
// out at 60s because the manifest URLs were unreachable via traefik.
//
// `ensureRouter` itself is idempotent: probe → adopt|resume|recreate
// |fresh against a fixed container name + image. Calling it on every
// `apply` invocation is therefore safe — it's a no-op against a healthy
// traefik container that's already running. The 10s timeout guards
// against a stuck docker daemon (which would otherwise stall the apply
// indefinitely); a timeout / failure here downgrades to "continue
// without traefik" so direct-port primitives still come up, matching
// the supervisor's behaviour on the `up` path.
//
// `caller` is annotated on the surrounding span so traces can
// distinguish `apply` vs `up` invocations.

import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { ensureRouter } from './docker.js';

export type RouterBootstrapCaller = 'apply' | 'up';

/** Wrap `ensureRouter` with the timeout + warn-fallback + opt-out
 *  envelope used by both the `up` and `apply` CLI paths. Returns an
 *  Effect that NEVER fails (failures are logged as warnings) so the
 *  caller can sequence it before its primary work without an extra
 *  catch. Requires `ChildProcessSpawner` in the environment — the
 *  caller is responsible for providing the Node platform layer. */
export const bootstrapRouterFor = (
	caller: RouterBootstrapCaller,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
	if (process.env.DEVSTACK_NO_ROUTER === '1') return Effect.void;
	return ensureRouter.pipe(
		Effect.timeoutOrElse({
			duration: '10 seconds',
			orElse: () =>
				Effect.logWarning(
					`devstack: traefik router boot timed out after 10s (${caller}) — continuing without it`,
				),
		}),
		Effect.catch((cause) =>
			Effect.logWarning(
				`devstack: traefik router boot failed (${caller}): ${(cause as { message?: string })?.message ?? String(cause)} — falling back to direct ports for any traefik-aware primitives`,
			),
		),
		Effect.withSpan('Devstack.bootstrapRouter', { attributes: { caller } }),
	);
};
