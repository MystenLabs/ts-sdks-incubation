// Common-port preflight probes. Uses the same dual-stack bind probe
// the engine's port allocator does so doctor's "bound (in use)" report
// matches what the supervisor sees at acquire time.
//
// Set is fixed (9000, 9123, 9125, 5180) — the state-store doesn't
// record per-snapshot port leases in a shape the CLI can read without
// booting the engine, so this is a best-effort common-defaults probe
// rather than a precise lease audit.

import { Effect } from 'effect';
import { createServer } from 'node:net';
import type { Check } from './_check.js';

export const COMMON_PORTS: ReadonlyArray<number> = [9000, 9123, 9125, 5180];

// Try to bind {addr}:port. EADDRINUSE → bound; clean close → free.
const tryBind = (port: number, addr: string): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const server = createServer();
		server.unref();
		server.once('error', (err) => {
			const code = (err as { code?: string }).code;
			resume(Effect.succeed(code === 'EADDRINUSE'));
		});
		server.listen(port, addr, () => {
			server.close(() => resume(Effect.succeed(false)));
		});
	});

// Probe BOTH `0.0.0.0` and `127.0.0.1`. Either bind failing means the
// port is unavailable to a freshly-launched docker `--publish`. A bare
// `0.0.0.0` probe alone misses processes that bound `127.0.0.1`
// explicitly (some local dev servers do); a bare `127.0.0.1` probe
// misses `::1`-only listeners and races past dual-stack binds. Mirror
// the engine's port-allocator probe so doctor's accounting matches
// what the supervisor will actually see at acquire time.
const isPortBound = (port: number): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const wildcardBound = yield* tryBind(port, '0.0.0.0');
		if (wildcardBound) return true;
		return yield* tryBind(port, '127.0.0.1');
	});

export const checkPort = (port: number): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const bound = yield* isPortBound(port);
		return {
			name: `port ${port}`,
			ok: true,
			required: false,
			detail: bound ? 'bound (in use)' : 'free',
		};
	});

export const checkCommonPorts = (): Effect.Effect<ReadonlyArray<Check>> =>
	Effect.gen(function* () {
		const out: Array<Check> = [];
		for (const p of COMMON_PORTS) {
			out.push(yield* checkPort(p));
		}
		return out as ReadonlyArray<Check>;
	});
