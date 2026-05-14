// Port allocator — hands out free TCP ports. Composite primitives (sui,
// walrus, seal, hostProcess, dockerContainer) use it instead of pinning
// host:container 1:1, so two stacks can run side-by-side without manual
// port juggling.
//
// `allocate(preferred)` scans forward from `preferred` up to `maxScan`
// ports, returning the first port that is (a) not in our held set and
// (b) bindable on `0.0.0.0`. We hold the port in a Ref so subsequent
// allocations don't race for the same number. `release(port)` removes
// from the set — the OS handles the actual socket teardown.

import { Context, Effect, Layer, Ref, Schema } from 'effect';
import * as net from 'node:net';

export interface PortAllocatorShape {
	/** Reserve a port near the preferred. If preferred is in use, scan forward up to maxScan. */
	readonly allocate: (
		preferred: number,
		options?: { maxScan?: number },
	) => Effect.Effect<number, PortAllocatorError>;
	/** Release a port previously allocated. */
	readonly release: (port: number) => Effect.Effect<void>;
	/** Snapshot of currently-held ports. */
	readonly snapshot: Effect.Effect<ReadonlyArray<number>>;
}

export class PortAllocator extends Context.Service<PortAllocator, PortAllocatorShape>()(
	'@devstack/PortAllocator',
) {}

export class PortAllocatorError extends Schema.TaggedErrorClass<PortAllocatorError>()(
	'PortAllocatorError',
	{
		preferred: Schema.Number,
		message: Schema.String,
	},
) {}

// OS-level probe: try to bind a fresh server to the port on BOTH
// 0.0.0.0 and 127.0.0.1. Docker's `-p 127.0.0.1:host:container` and
// our wallet-app server both bind specifically to 127.0.0.1 — a probe
// that only checked 0.0.0.0 would report the port free while
// another loopback-bound process still holds it (the kernel lets
// 0.0.0.0:N coexist with another listener on 127.0.0.1:N on macOS).
// Requiring both interfaces match what docker run / Node http actually
// claim. Any error (EADDRINUSE, EACCES, etc.) collapses to false.
const bindProbe = (port: number, host: string): Promise<boolean> =>
	new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => {
			server.close(() => resolve(true));
		});
		server.listen(port, host);
	});
const isPortFree = async (port: number): Promise<boolean> => {
	const [wildcardOk, loopbackOk] = await Promise.all([
		bindProbe(port, '0.0.0.0'),
		bindProbe(port, '127.0.0.1'),
	]);
	return wildcardOk && loopbackOk;
};

export const PortAllocatorLive: Layer.Layer<PortAllocator> = Layer.effect(
	PortAllocator,
	Effect.gen(function* () {
		const ref = yield* Ref.make<Set<number>>(new Set());

		const allocate = (
			preferred: number,
			options?: { maxScan?: number },
		): Effect.Effect<number, PortAllocatorError> =>
			Effect.gen(function* () {
				const maxScan = options?.maxScan ?? 100;
				for (let port = preferred; port <= preferred + maxScan; port++) {
					const held = yield* Ref.get(ref);
					if (held.has(port)) continue;
					const free = yield* Effect.tryPromise({
						try: () => isPortFree(port),
						catch: () => new PortAllocatorError({ preferred, message: `probe failed for ${port}` }),
					}).pipe(Effect.catch(() => Effect.succeed(false)));
					if (!free) continue;
					// Re-check + insert atomically via Ref.modify so two
					// concurrent allocate calls can't claim the same port.
					const claimed = yield* Ref.modify(ref, (s) => {
						if (s.has(port)) return [false, s] as const;
						const next = new Set(s);
						next.add(port);
						return [true, next] as const;
					});
					if (claimed) return port;
				}
				return yield* Effect.fail(
					new PortAllocatorError({
						preferred,
						message: `No free port found in [${preferred}, ${preferred + maxScan}]`,
					}),
				);
			}).pipe(Effect.withSpan('PortAllocator.allocate', { attributes: { preferred } }));

		const release = (port: number): Effect.Effect<void> =>
			Ref.update(ref, (s) => {
				if (!s.has(port)) return s;
				const next = new Set(s);
				next.delete(port);
				return next;
			});

		const snapshot: Effect.Effect<ReadonlyArray<number>> = Ref.get(ref).pipe(
			Effect.map((s) => Array.from(s)),
		);

		return { allocate, release, snapshot };
	}),
);
