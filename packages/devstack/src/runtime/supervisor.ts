// Long-running supervisor. Hosts the registry, reconciles the action
// graph on file changes / retries, renders the live status block, and
// shuts down cleanly on SIGINT / SIGTERM / `q` / `s` keystrokes.
//
// One reconcile cycle is in flight at any time. Concurrent triggers
// (file events, retries) coalesce into a `cyclePending` flag and re-fire
// after the current cycle completes. This keeps the action graph the
// single ordering authority — no parallel cycles racing on the same
// registry.
//
// Shutdown hooks fire in parallel: actions register them via
// `ActionRunContext.onShutdown` (see Discovery 2026-04-29). Each hook
// is typically `docker stop` against an independent container, so
// running them serially wasted N×10s of SIGTERM grace per teardown.
// Hooks that need ordering should compose internally — the supervisor
// makes no ordering guarantees. Real Service actions that detach a
// container generally don't register hooks — containers persist across
// `up` invocations by design (§9.4).

import { existsSync as fsExistsSync } from 'node:fs';
import type {
	AccountSpec,
	AccountsContext,
	Action,
	Network,
	PortAllocator,
	Plugin,
	ShutdownHook,
} from '../core/types.js';
import { expandPluginActions } from '../plugin.js';
import { RegistryImpl } from '../registry/index.js';
import { resolveAccounts } from './accounts.js';
import { DEFAULT_STACK, activeStackFile, writeActiveStack } from './active-stack.js';
import { FileWatcher } from './file-watcher.js';
import { hydrateRegistry } from './manifest-reader.js';
import { writeManifest } from './manifest-writer.js';
import { createPortAllocator } from './port-allocator.js';
import { Reconciler } from './reconcile.js';
import { StatusRenderer } from './status-renderer.js';

export interface SupervisorOptions {
	appName: string;
	appDir: string;
	plugins: Plugin[];
	/** Account specs from `DevstackConfig.accounts`. Resolved at startup
	 * into `ctx.accounts.<name>` for every action. Empty / undefined leaves
	 * the resolver with zero accounts — `ctx.accounts.names()` returns []. */
	accounts?: Record<string, AccountSpec>;
	/** Optional pre-resolved RPC URL plumbed into account factories. The
	 * supervisor resolves accounts before sui's Service action registers
	 * `sui-rpc`, so the built-in factories (cliSigner, envSigner,
	 * generatedKeypair) ignore this and other factories that need it can
	 * accept an empty string fallback. */
	rpcUrl?: string;
	stack?: string;
	network?: Network;
	stream?: NodeJS.WriteStream;
	tty?: boolean;
}

export class Supervisor {
	readonly appName: string;
	readonly appDir: string;
	readonly stack: string;
	readonly network: Network;

	private readonly actions: Action[];
	private readonly registry = new RegistryImpl();
	private readonly reconciler = new Reconciler();
	private readonly renderer: StatusRenderer;
	private readonly watcher: FileWatcher;
	private readonly shutdownHooks: ShutdownHook[] = [];
	private readonly accounts: AccountsContext;

	private readonly ports: PortAllocator;

	private cycleInFlight = false;
	private cyclePending = false;
	private stopped = false;

	private signalHandler: (() => void) | null = null;
	private keyHandler: ((c: Buffer) => void) | null = null;
	private exitResolver: (() => void) | null = null;
	private keepAlive: NodeJS.Timeout | null = null;

	constructor(opts: SupervisorOptions) {
		this.appName = opts.appName;
		this.appDir = opts.appDir;
		this.stack = opts.stack ?? DEFAULT_STACK;
		this.network = opts.network ?? 'localnet';
		if (this.network !== 'localnet') {
			throw new Error(
				`Supervisor is localnet-only — received network='${this.network}'. ` +
					`For one-shot live-network work use \`devstack apply --target ${this.network}\` ` +
					`or \`devstack deploy --network ${this.network}\`.`,
			);
		}
		// Ensure the active-stack pointer exists so out-of-band consumers
		// (Vite, tests, the `stack list` CLI) can resolve the right stack
		// without an explicit `stack use`.
		if (!fsExistsSync(activeStackFile(this.appDir))) {
			writeActiveStack(this.appDir, this.stack);
		}
		this.actions = expandPluginActions(opts.plugins);
		this.ports = createPortAllocator({ appDir: this.appDir, stack: this.stack });
		this.accounts = resolveAccounts({
			specs: opts.accounts ?? {},
			appDir: this.appDir,
			stack: this.stack,
			network: this.network,
			rpcUrl: opts.rpcUrl ?? '',
		});
		this.renderer = new StatusRenderer({
			actions: this.actions,
			stream: opts.stream,
			tty: opts.tty,
		});
		this.watcher = new FileWatcher({
			actions: this.actions,
			appDir: this.appDir,
			onStale: (names) => this.onFileStale(names),
		});
	}

	async start(): Promise<void> {
		this.renderer.start(this.appName);
		this.installSignalHandlers();
		this.hydrateFromManifest();
		await this.runCycle();
		this.watcher.start();
		this.installKeyHandlers();
		// A pending Promise alone doesn't anchor Node's event loop; in
		// headless mode (no TTY stdin handler, no chokidar watchers, no
		// active child IPC) the loop would drain and exit. A long-period
		// timer is the cheapest libuv handle that holds it open.
		this.keepAlive = setInterval(() => {}, 1 << 30);
		await new Promise<void>((resolve) => {
			this.exitResolver = resolve;
		});
	}

	/** Run one reconcile cycle, then shut down. For `devstack up --once`. */
	async runOnce(): Promise<void> {
		this.renderer.start(this.appName);
		this.installSignalHandlers();
		this.hydrateFromManifest();
		await this.runCycle();
		await this.shutdown();
	}

	/** Bulk-load the prior manifest into the registry so source actions'
	 * `getStatus()` skip predicates see prior on-chain state on a fresh
	 * process — e.g. seal's cached `KeyServer` objectId lands in the
	 * registry on cycle 1, getStatus probes the chain, skip. Mirrors
	 * the equivalent step in `runOneShot` (deploy path). */
	private hydrateFromManifest(): void {
		try {
			hydrateRegistry({
				appDir: this.appDir,
				stack: this.stack,
				network: this.network,
				registry: this.registry,
			});
		} catch (err) {
			this.renderer.appendLog('supervisor', `manifest hydrate failed: ${(err as Error).message}`);
		}
	}

	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.uninstallKeyHandlers();
		// Leave signal handlers installed; they're idempotent now (the
		// `stopped` guard short-circuits subsequent calls). Removing them
		// mid-shutdown can cause Node to exit before async work drains.
		await this.watcher.stop();
		// LIFO: tear down in reverse registration order. Surface a header
		// + per-hook completion line so users who hit Ctrl-C see the
		// supervisor is doing something — `docker stop` against multiple
		// containers can take 5-10s and silent shutdown looks hung.
		const hookCount = this.shutdownHooks.length;
		if (hookCount > 0) {
			this.renderer.appendLog(
				'supervisor',
				`shutting down (${hookCount} hook${hookCount === 1 ? '' : 's'} pending)…`,
			);
		}
		// Run hooks in parallel. Each is typically `docker stop` against an
		// independent container (or SIGINT to a child process) — sequential
		// teardown spent N×10s on Docker's SIGTERM grace period for free.
		// `Promise.allSettled` ensures one failure doesn't skip the rest.
		// Per-hook completion logs preserve forward-progress visibility.
		let completed = 0;
		await Promise.allSettled(
			this.shutdownHooks.map(async (hook) => {
				try {
					await hook();
					completed++;
					this.renderer.appendLog('supervisor', `hook ${completed}/${hookCount} done`);
				} catch (err) {
					completed++;
					this.renderer.appendLog(
						'supervisor',
						`hook ${completed}/${hookCount} failed: ${(err as Error).message}`,
					);
				}
			}),
		);
		this.shutdownHooks.length = 0;
		this.renderer.appendLog('supervisor', 'shutdown complete');
		this.renderer.stop();
		if (this.keepAlive !== null) {
			clearInterval(this.keepAlive);
			this.keepAlive = null;
		}
		this.uninstallSignalHandlers();
		if (this.exitResolver !== null) {
			const r = this.exitResolver;
			this.exitResolver = null;
			r();
		}
	}

	retryFailed(): void {
		const failed = this.actions.filter(
			(a) => this.reconciler.getState(a.name)?.status === 'failed',
		);
		if (failed.length === 0) {
			this.renderer.appendLog('supervisor', 'no failed actions to retry');
			return;
		}
		for (const a of failed) this.reconciler.resetAction(a.name);
		void this.runCycle();
	}

	private async runCycle(): Promise<void> {
		if (this.cycleInFlight) {
			this.cyclePending = true;
			return;
		}
		this.cycleInFlight = true;
		try {
			const result = await this.reconciler.cycle(this.actions, {
				appName: this.appName,
				appDir: this.appDir,
				stack: this.stack,
				network: this.network,
				registry: this.registry,
				accounts: this.accounts,
				ports: this.ports,
				onShutdown: (fn) => this.shutdownHooks.push(fn),
				appendLog: (actionName, line) => this.renderer.appendLog(actionName, line),
				progress: (snap) => this.renderer.update(snap.statuses, snap.failures),
			});
			this.renderer.update(result.statuses, result.failures);
			this.persistManifest();
		} catch (err) {
			// `cycle` only throws on contract bugs (cycle, dup name, unknown dep).
			this.renderer.appendLog('supervisor', `cycle aborted: ${(err as Error).message}`);
		} finally {
			this.cycleInFlight = false;
			if (this.cyclePending && !this.stopped) {
				this.cyclePending = false;
				queueMicrotask(() => {
					void this.runCycle();
				});
			}
		}
	}

	private persistManifest(): void {
		try {
			writeManifest({
				appName: this.appName,
				appDir: this.appDir,
				stack: this.stack,
				network: this.network,
				registry: this.registry,
			});
		} catch (err) {
			this.renderer.appendLog('supervisor', `manifest write failed: ${(err as Error).message}`);
		}
	}

	private onFileStale(names: string[]): void {
		this.renderer.markStale(names);
		for (const n of names) this.reconciler.resetAction(n);
		void this.runCycle();
	}

	private installSignalHandlers(): void {
		const onSig = () => {
			void this.shutdown();
		};
		this.signalHandler = onSig;
		// Use `on` (not `once`): repeated SIGINTs are no-ops via the
		// `stopped` guard in shutdown(), so we don't need re-registration.
		process.on('SIGINT', onSig);
		process.on('SIGTERM', onSig);
	}

	private uninstallSignalHandlers(): void {
		if (this.signalHandler === null) return;
		process.off('SIGINT', this.signalHandler);
		process.off('SIGTERM', this.signalHandler);
		this.signalHandler = null;
	}

	private installKeyHandlers(): void {
		if (!process.stdin.isTTY) return;
		try {
			process.stdin.setRawMode(true);
		} catch {
			return; // some environments (CI tty quirks) reject setRawMode
		}
		process.stdin.resume();
		const handler = (chunk: Buffer) => {
			const ch = chunk.toString('utf8');
			if (ch === '\x03' || ch === 'q' || ch === 's') {
				// Ctrl-C, q, s → shutdown. start() returns; CLI exits.
				void this.shutdown();
				return;
			}
			switch (ch) {
				case 'r':
					this.retryFailed();
					return;
				case 'l':
					this.renderer.toggleVerbose();
					return;
			}
		};
		this.keyHandler = handler;
		process.stdin.on('data', handler);
	}

	private uninstallKeyHandlers(): void {
		if (this.keyHandler === null) return;
		process.stdin.off('data', this.keyHandler);
		if (process.stdin.isTTY) {
			try {
				process.stdin.setRawMode(false);
			} catch {
				/* noop */
			}
		}
		process.stdin.pause();
		this.keyHandler = null;
	}
}
