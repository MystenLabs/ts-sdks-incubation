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
import type { Renderer } from './renderer.js';
import { PlainRenderer } from './renderers/plain.js';
import {
	type SupervisorLockHandle,
	acquireSupervisorLock,
} from './supervisor-lock.js';

interface SupervisorOptions {
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
	/** Status / log renderer. Defaults to a `PlainRenderer` writing to
	 * stdout — `cli/up.ts` swaps in `InkRenderer` when stdout is a TTY
	 * and `CI`/`DEVSTACK_NO_TUI`/`--no-tui` aren't set. */
	renderer?: Renderer;
}

export class Supervisor {
	readonly appName: string;
	readonly appDir: string;
	readonly stack: string;
	readonly network: Network;

	private readonly actions: Action[];
	private readonly registry = new RegistryImpl();
	private readonly reconciler: Reconciler;
	private readonly renderer: Renderer;
	private readonly watcher: FileWatcher;
	private readonly shutdownHooks: Array<{ label: string; run: ShutdownHook }> = [];
	private readonly accounts: AccountsContext;
	private lastRpcUrl: string | undefined;
	/** JSON-stringified last-pushed endpoints map. Cheap diff so the
	 * renderer doesn't re-render the URL-strewn detail column on every
	 * cycle when nothing has actually changed. */

	private readonly ports: PortAllocator;

	private cycleInFlight = false;
	private cyclePending = false;
	private cyclePromise: Promise<void> | null = null;
	private stopped = false;
	/** Memoized in-flight shutdown so concurrent callers (signal handler +
	 * `runOnce`'s explicit `await this.shutdown()`) await the same promise
	 * instead of one returning instantly while the other is mid-drain.
	 * Without this, `runOnce` would resume after the signal handler set
	 * `stopped=true` but BEFORE its hooks fired, the process would exit,
	 * and pending docker-stop promises would be killed mid-flight —
	 * leaving containers in `restarting` state forever. */
	private shutdownPromise: Promise<void> | null = null;
	private lock: SupervisorLockHandle | undefined;
	/** Aborted by `shutdown()` to stop the in-flight reconcile cycle from
	 * scheduling new actions. Without it, SIGINT mid-cycle leaves new
	 * containers / HostProcess children spawning past the shutdown hook
	 * drain — leaving them orphaned under Docker's `restart:
	 * unless-stopped` policy or as zombie node processes. Single
	 * controller per supervisor lifetime: once aborted, the supervisor
	 * is `stopped` and won't start more cycles. */
	private readonly abortController = new AbortController();

	private signalHandler: (() => void) | null = null;
	private keyHandler: ((c: Buffer) => void) | null = null;
	private exitResolver: (() => void) | null = null;
	private keepAlive: NodeJS.Timeout | null = null;
	private parentDeathTimer: NodeJS.Timeout | null = null;
	/** Returned by `Renderer.onAction()` if the renderer owns stdin (Ink).
	 * When set, the supervisor skips its built-in raw-mode handler and
	 * relies on the renderer's keypress callback. Cleared on shutdown. */
	private rendererActionRelease: (() => void) | null = null;

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
		this.renderer = opts.renderer ?? new PlainRenderer();
		this.lastRpcUrl = opts.rpcUrl;
		this.watcher = new FileWatcher({
			actions: this.actions,
			appDir: this.appDir,
			onStale: (names) => this.onFileStale(names),
		});
	}

	async start(): Promise<void> {
		await this.acquireLock();
		this.renderer.start({
			appName: this.appName,
			stack: this.stack,
			network: this.network,
			actions: this.actions,
			rpcUrl: this.lastRpcUrl,
		});
		this.installRendererActions();
		this.installSignalHandlers();
		this.hydrateFromManifest();
		this.renderer.appendLog(
			'supervisor',
			`reconciler ready · ${this.actions.length} action${this.actions.length === 1 ? '' : 's'}`,
		);
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
		this.renderer.start({
			appName: this.appName,
			stack: this.stack,
			network: this.network,
			actions: this.actions,
			rpcUrl: this.lastRpcUrl,
		});
		this.installRendererActions();
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
		if (this.shutdownPromise !== null) return this.shutdownPromise;
		this.stopped = true;
		this.shutdownPromise = (async () => {
			this.uninstallKeyHandlers();
			// Leave signal handlers installed; they're idempotent now (the
			// `shutdownPromise` memo above short-circuits subsequent calls).
			// Removing them mid-shutdown can cause Node to exit before
			// async work drains.
			await this.watcher.stop();
			// Abort the reconciler's scheduler so it stops kicking off new
			// actions. Inflight actions don't get cancelled by the signal
			// itself — but firing the shutdown hooks below `docker stop`s
			// their containers, which makes `waitForHealthy` throw, which
			// drains inflight naturally. So we DON'T wait for the cycle to
			// drain before firing hooks; we fire hooks first and let the
			// cycle settle as a side-effect.
			this.abortController.abort();
			// Hard ceiling on the entire shutdown sequence. Without it a
			// stuck docker stop or a `server.close()` waiting on keep-
			// alive sockets can hang the process indefinitely; the
			// signal-handler force-exit on a second Ctrl+C is the manual
			// escape, this is the automatic one.
			const SHUTDOWN_DEADLINE_MS = 20_000;
			const deadline = setTimeout(() => {
				process.stderr.write(
					`\ndevstack up: shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — force exit\n`,
				);
				process.exit(1);
			}, SHUTDOWN_DEADLINE_MS);
			deadline.unref();
			// Snapshot the hook list before draining so the renderer can
			// declare every label up front (Ink's ShutdownPanel renders
			// them all `pending` immediately, then transitions to
			// `running`/`done`/`failed` as we go). Late-registered hooks
			// from the in-flight cycle's tail are appended via
			// `progressShutdown` in the next round.
			const startedAt = Date.now();
			const initialHooks = [...this.shutdownHooks];
			this.renderer.beginShutdown(initialHooks.map((h) => ({ label: h.label })));
			let completed = 0;
			let failed = 0;
			const drainBatch = async (
				batch: Array<{ label: string; run: ShutdownHook }>,
			): Promise<void> => {
				await Promise.allSettled(
					batch.map(async (hook) => {
						this.renderer.progressShutdown(hook.label, 'running');
						try {
							await hook.run();
							completed++;
							this.renderer.progressShutdown(hook.label, 'done');
						} catch (err) {
							failed++;
							this.renderer.progressShutdown(
								hook.label,
								'failed',
								(err as Error).message,
							);
						}
					}),
				);
			};
			// Drain in rounds so late-registered hooks (cycle actions
			// that called `ctx.onShutdown` AFTER abort but BEFORE
			// observing it) still fire. Cap at a few rounds to bound
			// the loop on a buggy plugin that registers hooks indefinitely.
			let round = 0;
			while (this.shutdownHooks.length > 0 && round < 4) {
				const batch = this.shutdownHooks.splice(0);
				if (round > 0) {
					// Late hooks weren't in the initial declaration; declare
					// them now so the renderer knows their labels before they
					// transition to 'running'.
					this.renderer.beginShutdown(batch.map((h) => ({ label: h.label })));
				}
				await drainBatch(batch);
				round++;
			}
			// Best-effort drain of the cycle: if it's still going (e.g. a
			// plugin's run is past the abort check but hasn't hit a
			// container-dependent await yet), give it a brief window to
			// settle. Bounded so we don't hang on a stuck plugin.
			const inflight = this.cyclePromise;
			if (inflight !== null) {
				let raceTimer: NodeJS.Timeout | undefined;
				const timeout = new Promise<void>((res) => {
					raceTimer = setTimeout(res, 5_000);
				});
				try {
					await Promise.race([inflight.catch(() => undefined), timeout]);
				} finally {
					// Without clearing this, the leaked timer keeps Node's
					// event loop alive for the full 5s after `inflight`
					// already resolved — looking like a hang to the user.
					if (raceTimer !== undefined) clearTimeout(raceTimer);
				}
				if (this.shutdownHooks.length > 0) {
					const batch = this.shutdownHooks.splice(0);
					this.renderer.beginShutdown(batch.map((h) => ({ label: h.label })));
					await drainBatch(batch);
				}
			}
			clearTimeout(deadline);
			this.renderer.finishShutdown({
				completed,
				failed,
				durationMs: Date.now() - startedAt,
			});
			this.renderer.stop();
			this.uninstallRendererActions();
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
			// Belt-and-braces: if anything in ink's stdin teardown,
			// chokidar's close, or a stray plugin handle is still
			// holding the event loop open, force-exit on the next tick.
			// We've done the clean shutdown work — there's nothing left
			// to drain.
			setTimeout(() => process.exit(0), 250).unref();
		})();
		return this.shutdownPromise;
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
		if (this.stopped) return;
		if (this.cycleInFlight) {
			this.cyclePending = true;
			return;
		}
		this.cycleInFlight = true;
		// Snapshot registry state before the cycle. We use this to detect
		// late-registered services / packages that downstream Service
		// actions may want to react to. The canonical case: `frontend.
		// dev-server` registers the `dev-server` service late in the cycle,
		// AFTER `wallet-server.serve` already started with an empty CORS
		// allowlist. The 2nd cycle's getStatus on wallet-server.serve sees
		// the new entry, returns ok:false (drift), and triggers the
		// hot-reload of `setAllowedOrigins`. Without an automatic re-cycle
		// the user would be stuck with 403'd CORS until a file change
		// kicked the watcher.
		const serviceCountBefore = this.registry.services.list().length;
		const cycleWork = (async () => {
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
					onShutdown: (label, fn) => this.shutdownHooks.push({ label, run: fn }),
					appendLog: (actionName, line) => this.renderer.appendLog(actionName, line),
					progress: (snap) => this.renderer.update(snap.statuses, snap.failures),
					lenient: opts.hostProcessOnly,
					signal: this.abortController.signal,
				});
				this.renderer.update(result.statuses, result.failures);
				this.refreshRpcUrl();
				this.refreshRegistry();
				this.persistManifest();
			} catch (err) {
				// `cycle` only throws on contract bugs (cycle, dup name, unknown dep).
				this.renderer.appendLog('supervisor', `cycle aborted: ${(err as Error).message}`);
			}
		})();
		this.cyclePromise = cycleWork;
		try {
			await cycleWork;
		} finally {
			this.cycleInFlight = false;
			this.cyclePromise = null;
			const serviceCountAfter = this.registry.services.list().length;
			const servicesGrew = serviceCountAfter > serviceCountBefore;
			if (this.cyclePending && !this.stopped) {
				this.cyclePending = false;
				queueMicrotask(() => {
					void this.runCycle();
				});
			} else if (servicesGrew && !this.stopped && !this.cycleReentered) {
				// Bounded one-shot re-entry to settle late-registered
				// services. `cycleReentered` clears at the next foreign
				// trigger (file watcher, manual retry) so a steady-state
				// stack doesn't loop.
				this.cycleReentered = true;
				queueMicrotask(() => {
					void this.runCycle().finally(() => {
						this.cycleReentered = false;
					});
				});
			}
		}
	}

	/** Guard so the post-cycle re-entry (services-grew path) only fires
	 * once per outer trigger. Without it, a getStatus probe that
	 * registers a service every cycle would loop forever. */
	private cycleReentered = false;

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
		// First SIGINT/SIGTERM → graceful shutdown. Second → force exit.
		// Without this, a stuck shutdown hook (slow docker stop, server.
		// close() blocking on keepalive sockets) leaves the user hammering
		// Ctrl+C with no escape, since `shutdown()`'s memoized promise
		// makes every subsequent SIGINT a no-op.
		let sigCount = 0;
		const onSig = () => {
			sigCount++;
			if (sigCount >= 2) {
				process.stderr.write('\ndevstack up: force exit (Ctrl+C twice)\n');
				process.exit(130);
			}
			void this.shutdown();
		};
		this.signalHandler = onSig;
		process.on('SIGINT', onSig);
		process.on('SIGTERM', onSig);

		// Parent-death watcher. `pnpm <bin>` (and `pnpm run <script>`) does
		// not always forward SIGINT to its node child — when the parent
		// exits without doing so, the supervisor gets re-parented to init
		// (`ppid === 1`) and would otherwise keep running with no signal
		// at all, leaking docker containers + child processes. Polling
		// `process.ppid` is cheap (a syscall every 1.5s); cross-platform
		// (works on Linux + macOS without prctl/kqueue plumbing); and
		// avoids any native-helper dependency. Skip if we're already
		// orphaned at startup (e.g. nohup'd into the background) — that's
		// a deliberate detach, not the bug we're guarding against.
		if (process.platform !== 'win32' && process.ppid !== 1) {
			const initialPpid = process.ppid;
			this.parentDeathTimer = setInterval(() => {
				if (this.stopped) return;
				if (process.ppid === 1 || process.ppid !== initialPpid) {
					this.renderer.appendLog(
						'supervisor',
						`parent process exited (ppid ${initialPpid} → ${process.ppid}) — shutting down`,
					);
					void this.shutdown();
				}
			}, 1_500);
			// Don't anchor the event loop: if the supervisor is otherwise
			// idle (e.g. between `start()`'s keepAlive interval and the
			// shutdown drain), we don't want this poller to keep node
			// alive on its own.
			this.parentDeathTimer.unref?.();
		}
	}

	private uninstallSignalHandlers(): void {
		if (this.signalHandler === null) return;
		process.off('SIGINT', this.signalHandler);
		process.off('SIGTERM', this.signalHandler);
		this.signalHandler = null;
		if (this.parentDeathTimer !== null) {
			clearInterval(this.parentDeathTimer);
			this.parentDeathTimer = null;
		}
	}

	/** Wire the renderer's optional `onAction` callback. When the
	 * renderer owns stdin (Ink in TTY mode), this is the only keybind
	 * path; the supervisor's `installKeyHandlers` becomes a no-op. */
	private installRendererActions(): void {
		const onAction = this.renderer.onAction;
		if (onAction === undefined) return;
		this.rendererActionRelease = onAction.call(this.renderer, (action) => {
			switch (action) {
				case 'shutdown':
					void this.shutdown();
					return;
				case 'retry':
					this.retryFailed();
					return;
			}
		});
	}

	private uninstallRendererActions(): void {
		if (this.rendererActionRelease === null) return;
		try {
			this.rendererActionRelease();
		} catch {
			/* noop — renderer is going away anyway */
		}
		this.rendererActionRelease = null;
	}

	/** Push the live registry snapshot to the renderer so the TUI's
	 * `registry` tab can render it. Plain renderer ignores the call.
	 * Cheap: snapshot is a structural copy of the in-memory maps; no
	 * I/O. */
	private refreshRegistry(): void {
		if (this.renderer.setRegistry === undefined) return;
		this.renderer.setRegistry(this.registry.snapshot());
	}

	/** Push the latest `sui-rpc` URL into the renderer's header. The sui
	 * plugin registers this service late in cycle 1 (after `docker run`
	 * + healthcheck), so we re-read after every cycle. Cheap on misses. */
	private refreshRpcUrl(): void {
		const services = this.registry.services.list();
		const rpc = services.find((s) => s.name === 'sui-rpc' || s.kind === 'sui-rpc');
		if (rpc === undefined) return;
		if (rpc.url === this.lastRpcUrl) return;
		this.lastRpcUrl = rpc.url;
		this.renderer.setRpcUrl?.(rpc.url);
		this.renderer.appendLog('supervisor', `rpc → ${rpc.url}`);
	}

	private installKeyHandlers(): void {
		// Ink owns stdin and registers its own keybinds via
		// `Renderer.onAction`; suppress the supervisor's raw-mode handler
		// to avoid two listeners fighting over each keystroke.
		if (this.rendererActionRelease !== null) return;
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
