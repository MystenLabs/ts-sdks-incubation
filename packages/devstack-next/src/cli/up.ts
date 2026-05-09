import { Engine } from '../engine/class.js';
import type { DevstackConfig, Env } from '../engine/types.js';
import { attachFileWatcher } from '../file-watcher.js';
import { tryReadSnapshot, writeSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { loadConfigAndEnv } from './env.js';
import { attachPlainRenderer } from './output.js';

export const UP_USAGE = `devstack-next up [options]

Long-running supervisor. Reads the prior snapshot, runs the first cycle,
auto-saves a snapshot at each cycle:end, and idles until SIGINT. Use
\`apply\` for the one-shot variant.

While idling, watches every path that nodes registered via
\`runArgs.watch(...)\` (e.g. publishMove watches its Move source dir);
fs events trigger \`engine.invalidate(name)\` and a fresh cycle, debounced
~150ms so editor save bursts coalesce into a single rebuild.

Options:
  --config <path>             Override the config path (default: walk up
                              from cwd looking for devstack.config.ts)
  --network <net>             Network: localnet | testnet | mainnet | devnet
                              (default: localnet)
  --stack <name>              Per-stack name (default: 'main', localnet only)
  --no-tui                    Force the line-oriented plain renderer
                              even on a TTY. Auto-applied when stdout
                              isn't a TTY (CI logs, redirected output).
  --no-watch                  Disable file-watching. Cycles only fire from
                              SIGUSR2 (manual re-trigger) or SIGINT (stop).
  -h, --help                  Show this help
`;

export type RendererKind = 'tui' | 'plain';

export interface RunUpOptions {
	config: DevstackConfig;
	env: Env;
	/** Where to write progress. Used by the plain renderer; ignored by
	 * the TUI which takes over the terminal. Defaults to process.stderr. */
	out?: NodeJS.WriteStream;
	/** Provide a custom signal source for testing — defaults to a real
	 * SIGINT/SIGTERM handler on the process. The promise resolves when
	 * the user wants the supervisor to stop. */
	stopSignal?: Promise<void>;
	/** Force a specific renderer. Default: 'tui' on a TTY, 'plain' off. */
	renderer?: RendererKind;
	/** Disable file-watching. Default: enabled. */
	noWatch?: boolean;
	/** Override the debounce window for fs events. Default 150ms. */
	watchDebounceMs?: number;
}

export async function runUp(opts: RunUpOptions): Promise<number> {
	const out = opts.out ?? process.stderr;
	const initial = await tryReadSnapshot(opts.env);
	const engine = new Engine(opts.config, {
		env: opts.env,
		...(initial !== undefined ? { initialSnapshot: initial } : {}),
	});

	let stopSignalResolve: (() => void) | undefined;
	const tuiQuitSignal = new Promise<void>((r) => {
		stopSignalResolve = r;
	});

	// Pick a renderer. The Ink TUI dynamic-imports so the plain CI path
	// doesn't pay the React + ink load cost.
	const kind: RendererKind = opts.renderer ?? (process.stdout.isTTY ? 'tui' : 'plain');
	let detachRenderer: () => void | Promise<void>;
	if (kind === 'tui') {
		const mod = await import('../tui/renderer.js');
		const tui = mod.attachInkRenderer({
			engine,
			env: opts.env,
			onQuit: () => stopSignalResolve?.(),
		});
		detachRenderer = () => tui.detach();
	} else {
		detachRenderer = attachPlainRenderer(engine, { out });
	}

	// Auto-save a snapshot at each cycle:end. Errors are emitted as
	// engine:error so the renderer surfaces them, then we keep going —
	// snapshot write failure shouldn't take the supervisor down.
	const detachSnapshotWriter = engine.subscribe((event) => {
		if (event.type !== 'cycle:end') return;
		void engine
			.saveSnapshot()
			.then((snapshot) => writeSnapshot(opts.env, snapshot))
			.catch((err) => {
				if (kind === 'plain') {
					out.write(
						`  ! snapshot write failed: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			});
	});

	const detachWatcher =
		opts.noWatch === true
			? () => undefined
			: attachFileWatcher(engine, {
					// Plain-renderer path logs each fired cycle for visibility;
					// the TUI has its own event-driven view, so suppress
					// duplicate stderr noise there.
					...(kind === 'plain'
						? { log: (line: string) => out.write(`${line}\n`) }
						: {}),
					...(opts.watchDebounceMs !== undefined ? { debounceMs: opts.watchDebounceMs } : {}),
				});

	const externalStop = opts.stopSignal ?? defaultStopSignal();
	const stopSignal = Promise.race([externalStop, tuiQuitSignal]);

	const startPromise = engine.start();
	stopSignal.then(() => engine.stop()).catch(() => {
		/* signal source errors aren't fatal */
	});
	await startPromise;

	detachWatcher();
	detachSnapshotWriter();
	await detachRenderer();
	return 0;
}

// Listen once on SIGINT/SIGTERM. Returns a promise that resolves when
// either fires. Both are removed once one fires so a follow-up Ctrl-C
// after stop() begins falls through to Node's default behavior (a hard
// exit), giving the operator an escape hatch.
function defaultStopSignal(): Promise<void> {
	return new Promise<void>((resolve) => {
		const onSig = () => {
			process.off('SIGINT', onSig);
			process.off('SIGTERM', onSig);
			resolve();
		};
		process.once('SIGINT', onSig);
		process.once('SIGTERM', onSig);
	});
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true) {
		process.stdout.write(UP_USAGE);
		return 0;
	}
	const loaded = await loadConfigAndEnv({
		cwd: process.cwd(),
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.network !== undefined ? { network: flags.network } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const noTui = hasFlag(argv, '--no-tui');
	const noWatch = hasFlag(argv, '--no-watch');
	return runUp({
		config: loaded.config,
		env: loaded.env,
		...(noTui || !process.stdout.isTTY ? { renderer: 'plain' as const } : {}),
		...(noWatch ? { noWatch: true } : {}),
	});
}
