import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { hostProcess } from '../runners/host-process.js';
import { ports } from '../standard/ports.js';
import type { Endpoint } from '../shapes/index.js';

export interface ViteDevServerOptions {
	/** Logical node name for the public producer. Default
	 * `frontend.dev-server`. */
	name?: string;
	/** Slot key for the port allocator. Default `frontend.dev-server`.
	 * Override only if you're spinning up multiple dev servers and need
	 * disjoint port allocations. */
	slot?: string;
	/** Pin a literal port for the dev server, bypassing the per-stack
	 * allocator entirely. Useful when an external consumer needs to
	 * know the URL up-front — e.g. Playwright's `baseURL` is set at
	 * config-eval time and can't track a runtime-allocated port. With
	 * `port` set, vite is invoked with `--port <n>`; the example's
	 * `vite.config.ts` `strictPort` setting decides whether a busy
	 * port raises or falls back. */
	port?: number;
	/** Working dir for the spawn. Default: env.appDir. */
	cwd?: string;
	/** Override the spawn. Default `pnpm exec vite`. The allocated port
	 * is appended via `--port <number>`. */
	command?: { command: string; args: string[] };
	/** Producers the dev server should wait for. Wire any node whose
	 * output the frontend imports — typically the `manifest` or
	 * `bindings` producer. The dev server doesn't start until each gate
	 * has produced state.
	 *
	 * Cross-plugin fan-in works the same as anywhere else: pass the
	 * Deps through and the engine pulls them in transitively. */
	gates?: Dep<unknown>[];
}

export interface ViteDevServerState {
	url: string;
	port: number;
}

const provides = {
	endpoint: dep((s: ViteDevServerState): Endpoint => ({
		name: 'dev-server',
		url: s.url,
		kind: 'dev-server',
	})),
	url: dep((s: ViteDevServerState) => s.url),
	port: dep((s: ViteDevServerState) => s.port),
	full: dep((s: ViteDevServerState) => s),
} satisfies Provides<ViteDevServerState>;

// `viteDevServer({ gates: [manifest.get('full'), bindings.get('full')] })`
// — minimal wrapper around `hostProcess` that spawns Vite on an
// allocated host port and exposes the URL via a typed Dep.
//
// Old devstack had this as a full plugin (`frontend()`); in the new
// design it's a small composition of primitives the user could write
// themselves. The helper exists for ergonomics, not because there's
// anything plugin-shaped about it.
//
// Two graph nodes are produced:
//   - `<name>.process` — private hostProcess that runs Vite
//   - `<name>` — pure-transformer Producer surfacing the URL
//
// Returning one producer (with the proc as a private upstream) means
// the user lists `viteDevServer({...})` in their stack and the engine
// pulls in the proc transitively via the dep graph.
export function viteDevServer(opts: ViteDevServerOptions = {}) {
	const name = opts.name ?? 'frontend.dev-server';
	const slot = opts.slot ?? 'frontend.dev-server';
	const baseCommand = opts.command ?? { command: 'pnpm', args: ['exec', 'vite'] };
	const pinnedPort = opts.port;

	// hostProcess takes a single deps record. When `port:` is set the
	// allocator's `_port` Dep is omitted (literal port wins); otherwise
	// the allocator Dep flows in. Gates ride alongside either way.
	const procDeps: Record<string, Dep<unknown>> = {};
	if (pinnedPort === undefined) {
		procDeps._port = ports.get('allocate', { slot });
	}
	if (opts.gates !== undefined) {
		opts.gates.forEach((gate, i) => {
			procDeps[`_gate${i}`] = gate as Dep<unknown>;
		});
	}

	const proc = hostProcess({
		name: `${name}.process`,
		deps: procDeps,
		command: baseCommand.command,
		args: ({ deps }) => {
			const port = pinnedPort ?? (deps as { _port: number })._port;
			return [...baseCommand.args, '--port', String(port)];
		},
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		inputs: ({ deps }) => ({
			port: pinnedPort ?? (deps as { _port: number })._port,
			command: baseCommand.command,
			args: baseCommand.args,
		}),
	});

	const outerDeps: Record<string, Dep<unknown>> = {
		proc: proc.get('full') as Dep<unknown>,
	};
	if (pinnedPort === undefined) {
		outerDeps.port = ports.get('allocate', { slot }) as Dep<unknown>;
	}

	return define<ViteDevServerState, typeof provides>({
		name,
		deps: outerDeps,
		provides,
		// `proc` is unused at projection time but listing it as a Dep
		// pulls the hostProcess into the graph and ensures this node's
		// identity flips when the process state flips (e.g. pid change
		// after a re-spawn).
		inputs: ({ deps }) => ({
			port: pinnedPort ?? (deps as { port: number }).port,
		}),
		start: async ({ deps }): Promise<ViteDevServerState> => {
			const port = pinnedPort ?? (deps as { port: number }).port;
			return { port, url: `http://localhost:${port}` };
		},
		represents: {
			endpoints: (s: ViteDevServerState): Endpoint[] => [
				{ name: 'dev-server', url: s.url, kind: 'dev-server' },
			],
		},
	});
}
