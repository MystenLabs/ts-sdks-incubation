// Long-running supervisor: hosts the registry, reconciles the action graph
// on file changes / retries, renders the live status block, and shuts down
// cleanly on SIGINT / SIGTERM / `q` / `s` keystrokes. One reconcile cycle is
// in flight at any time; concurrent triggers coalesce. Shutdown hooks fire
// in parallel — they're typically `docker stop` against independent
// containers; serial teardown wasted N×10s of SIGTERM grace.

import { existsSync as fsExistsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type {
	AccountsConfig,
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
import { DEFAULT_STACK, activeStackFile, stackDir, writeActiveStack } from './active-stack.js';
import { FileWatcher } from './file-watcher.js';
import { hydrateRegistry, readReconcilerState } from './manifest-reader.js';
import { writeManifest } from './manifest-writer.js';
import { createPortAllocator } from './port-allocator.js';
import { Reconciler } from './reconcile.js';
import { StatusRenderer } from './status-renderer.js';
import {
	type SupervisorLockHandle,
	acquireSupervisorLock,
} from './supervisor-lock.js';

export interface SupervisorOptions {
	appName: string;
	appDir: string;
	plugins: Plugin[];
	/** Account specs from `DevstackConfig.accounts`. Resolved at startup
	 * into `ctx.accounts.<name>` for every action. Empty / undefined leaves
	 * the resolver with zero accounts — `ctx.accounts.names()` returns []. */
	accounts?: AccountsConfig;
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
	private readonly reconciler: Reconciler;
	private readonly renderer: StatusRenderer;
	private readonly watcher: FileWatcher;
	private readonly shutdownHooks: ShutdownHook[] = [];
	private readonly accounts: AccountsContext;

	private readonly ports: PortAllocator;

	private cycleInFlight = false;
	private cyclePending = false;
	private stopped = false;
	private lock: SupervisorLockHandle | undefined;

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
			specs: opts.accounts ?? [],
			appDir: this.appDir,
			stack: this.stack,
			network: this.network,
			rpcUrl: opts.rpcUrl ?? '',
		});
		// Hydrate persisted reconciler state from the prior manifest so a
		// fresh `devstack up` against an existing stack treats already-
		// applied setup actions (Publish / Register / Seed / Emit / Build)
		// as healthy on input-hash match — without rerunning getStatus.
		// Service / HostProcess / Verify still re-probe every cycle.
		const priorState = readReconcilerState({
			appDir: this.appDir,
			stack: this.stack,
			network: this.network,
		});
		this.reconciler = new Reconciler({ priorState });
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
		await this.acquireLock();
		this.renderer.start(this.appName);
		this.installSignalHandlers();
		this.hydrateFromManifest();
		const fastStart = this.consumeRecentApplyMarker();
		await this.runCycle({ hostProcessOnly: fastStart });
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
		await this.acquireLock();
		this.renderer.start(this.appName);
		this.installSignalHandlers();
		this.hydrateFromManifest();
		await this.runCycle();
		await this.shutdown();
	}

	/** Acquire the per-(app, stack) lockfile so two `devstack up`
	 * invocations don't fight over container names + manifest writes.
	 * Throws `SupervisorLockBusyError` when another supervisor is
	 * already running; the caller (CLI entry) reports that to stderr. */
	private async acquireLock(): Promise<void> {
		this.lock = await acquireSupervisorLock({ appDir: this.appDir, stack: this.stack });
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
		// Release the lockfile last so observers don't see it gone
		// before our containers are stopped.
		this.lock?.release();
		this.lock = undefined;
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

	private async runCycle(opts: { hostProcessOnly?: boolean } = {}): Promise<void> {
		if (this.cycleInFlight) {
			this.cyclePending = true;
			return;
		}
		this.cycleInFlight = true;
		try {
			// Fast-start path: globalSetup just ran apply, the chain is at
			// known state. Skip the heavy non-HostProcess reconcile work
			// (~5s of getStatus probes that would all return ok=true) and
			// only spawn the HostProcess actions vite + wallet-server need.
			// Subsequent cycles run the full graph.
			const actions = opts.hostProcessOnly
				? this.actions.filter((a) => a.type === 'HostProcess')
				: this.actions;
			if (opts.hostProcessOnly && actions.length > 0) {
				this.renderer.appendLog(
					'supervisor',
					`fast-start: skipping ${this.actions.length - actions.length} non-HostProcess action(s) (recent apply)`,
				);
			}
			const result = await this.reconciler.cycle(actions, {
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
				lenient: opts.hostProcessOnly,
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

	/** When `globalSetup` (Playwright) or another sibling tool just
	 * finished applying, it writes a fresh-apply marker into
	 * `<stackDir>/.last-apply-at`. This supervisor's first cycle uses
	 * that to skip the redundant reconcile of non-HostProcess actions
	 * that the apply just verified (~5s recoverable on warm e2e).
	 * Marker is consumed (deleted) so only the very next start
	 * benefits — drift after that is detected normally. */
	private consumeRecentApplyMarker(): boolean {
		const path = pathResolve(stackDir(this.appDir, this.stack), '.last-apply-at');
		if (!fsExistsSync(path)) return false;
		try {
			const at = Number(readFileSync(path, 'utf8').trim());
			unlinkSync(path);
			if (!Number.isFinite(at)) return false;
			const ageMs = Date.now() - at;
			if (ageMs < 0 || ageMs > 30_000) return false;
			return true;
		} catch {
			return false;
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
				actionStates: this.reconciler.serializeState(),
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
