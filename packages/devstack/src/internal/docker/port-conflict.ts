// Shared `onPortConflict` builder for primitives wiring `Docker.run`.
//
// When `Docker.run`'s resume path detects a port-conflict stderr from
// `docker start` (`isPortConflictStderr` matches), it can call back into
// the primitive to obtain a fresh host→container port mapping for the
// recreate path. The primitive is the only thing that knows about
// `PortAllocator`; `Docker.run` itself is allocator-agnostic.
//
// The UX goal: pause stack A → boot stack B → B's sui gets the preferred
// port 9000. Resume A → A wants 9000 but B has it → A SHIFTS to the next
// free preferred port (9001), not a random ephemeral (53782). Browser
// URLs and manifest endpoints stay readable.
//
// Mechanism: passing `preferred = the just-released hostPort` to
// `PortAllocator.allocate` re-tries the original preferred; if still
// taken, the allocator scans forward (its `allocate(preferred)` semantics
// already do this — see `port-allocator.ts`). That matches the user's
// "next preferred port" expectation: 9000 → 9001 → 9002.
//
// Finalizer accounting: the primitive's original allocate registered an
// `Effect.addFinalizer(() => allocator.release(oldPort))`. We release
// `oldPort` immediately here (idempotent — release is a no-op if the
// port isn't in the held set), then register a fresh finalizer for the
// new port. The dangling original finalizer still fires on scope close
// and is a safe no-op against the now-released old port.

import { Effect } from 'effect';
import { addFinalizer, type Scope } from 'effect/Scope';
import type { PortAllocator } from '../port-allocator.js';
import { DockerError } from '../../primitives/errors.js';

/**
 * Build the `onPortConflict` callback for `Docker.run`. Releases each
 * conflicting host port back to the allocator, then re-allocates using
 * the same value as `preferred` so the allocator either returns the
 * original port (if it has come free in the meantime) or scans forward
 * to the next free preferred-style slot.
 *
 * `scope` is the scope the new-port release finalizers attach to —
 * typically the primitive's enclosing scope (the same one its original
 * `allocate` finalizer ran on). The callback's signature is
 * `Effect<…, DockerError, never>` so `Docker.run` can invoke it without
 * widening its own `R` channel; the scope is captured at construction
 * time instead of carried in the environment.
 *
 * `op` names the calling primitive for the surrounding `DockerError`
 * envelope when re-allocation fails — e.g. `'sui.localnet'` →
 * `"sui.localnet: could not re-allocate ..."`.
 */
export const reallocatePortsOnConflict =
	(allocator: typeof PortAllocator.Service, scope: Scope, op: string) =>
	(
		conflicting: Readonly<Record<number, number>>,
	): Effect.Effect<Readonly<Record<number, number>>, DockerError, never> =>
		Effect.gen(function* () {
			const newPorts: Record<number, number> = {};
			for (const [hostPortStr, containerPort] of Object.entries(conflicting)) {
				const hostPort = Number(hostPortStr);
				// Release first so the about-to-allocate call doesn't see the
				// old port in our own held set (it would scan past). Release
				// is idempotent — the primitive's original finalizer can still
				// fire harmlessly on scope close.
				yield* allocator.release(hostPort);
				const fresh = yield* allocator.allocate(hostPort).pipe(
					Effect.mapError(
						(cause) =>
							new DockerError({
								op,
								message: `${op}: could not re-allocate host port near ${hostPort} after port conflict: ${cause.message}`,
								cause,
							}),
					),
				);
				// Tie release of the new port to the primitive's scope —
				// matches where the original allocate finalizer landed, so
				// teardown timing is symmetric.
				yield* addFinalizer(scope, allocator.release(fresh).pipe(Effect.ignore));
				newPorts[fresh] = containerPort;
			}
			return newPorts;
		}).pipe(Effect.withSpan('Docker.reallocatePortsOnConflict', { attributes: { op } }));
