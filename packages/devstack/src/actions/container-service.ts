// `containerService()` — Service action factory for long-running Docker
// containers (sui localnet, seal key-server, walrus storage nodes, etc.).
//
// Most container plugins repeat the same lifecycle: inspect → resume-or-run
// → wait-for-healthy → register-shutdown. This helper expresses that pattern
// declaratively from a `spec(ctx) => RunContainerOptions` builder, so plugin
// code stays focused on what's unique (the spec) instead of repeating the
// imperative remove+rerun dance.
//
// Pair with `provides: { registry: ... }` to populate the in-memory
// registry on warm-path skips.

import {
	type LocalnetActionRunContext,
	type Provides,
	type ServiceAction,
	type SnapshotMeta,
	requireLocalnetCtx,
} from '../core/types.js';
import {
	type ContainerInfo,
	type RunContainerOptions,
	inspectContainer,
	removeContainer,
	runContainer,
	startContainer,
	stopContainer,
	waitForHealthy,
} from '../plugins/sui/docker.js';

interface ContainerServiceOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	/** Per-stack container name (typically `${appName}-${stack}-<service>`). */
	containerName: (ctx: LocalnetActionRunContext) => string;
	/** Builds the docker-run spec when `run` fires. Called inside `run` only —
	 * `getStatus` doesn't compute it. The returned `name` is overwritten by
	 * the helper with `containerName(ctx)`, so callers can leave it as `''`. */
	spec: (
		ctx: LocalnetActionRunContext,
	) => Promise<RunContainerOptions> | RunContainerOptions;
	/** Optional probe layered on top of the docker healthcheck. When set,
	 * `getStatus` returns its result (the docker healthcheck still gates
	 * `running` first). Use for plugins where the docker healthcheck is
	 * absent (nginx proxy) or insufficient (sui's checkpoint-retention check
	 * on top of RPC reachability). */
	probe?: (
		ctx: LocalnetActionRunContext,
		info: ContainerInfo,
	) => Promise<{ ok: boolean; detail?: string }>;
	/** Run before the container is created — e.g. `ensureNetwork`, write a
	 * generated config file. */
	preRun?: (ctx: LocalnetActionRunContext) => Promise<void>;
	/** Wait for the service after `runContainer` returns. Default: when the
	 * spec carries a `healthcheck`, `waitForHealthy` runs with the configured
	 * `timeoutMs`. Plugins that need a custom probe (`waitForRpc`,
	 * `waitForReachable`) supply their own here. */
	postStart?: (ctx: LocalnetActionRunContext, containerName: string) => Promise<void>;
	/** Stop-on-shutdown (Ctrl-C, supervisor exit) so the container halts
	 * cleanly. The next `up` cycle reuses the volume and recreates. Default
	 * `true`. */
	stopOnShutdown?: boolean;
	/** Override the default `waitForHealthy` timeout when the spec has a
	 * docker healthcheck. Default 5 min. */
	healthyTimeoutMs?: number;
	/** Snapshot capture metadata. The orchestrator (`runtime/snapshot.ts`)
	 * reads these via `devstack.snapshot.*` labels on the container —
	 * `containerService` merges them into `spec.labels` at `docker run`
	 * time and stamps `snapshotMeta` on the resulting Action so callers
	 * can introspect.
	 *
	 *   - `commit: false` for stateless containers (seal, walrus.proxy)
	 *     — skip the `docker commit` and the seed image entirely.
	 *   - `quiesce: 'pause'` for single-writer RocksDB (sui localnet)
	 *     — fastest safe capture.
	 *   - `quiesce: 'stop'` (the default) for batched-write services
	 *     (walrus storage nodes) — graceful flush.
	 *   - `quiesce: 'none'` when there's nothing to flush (stateless).
	 *
	 * Default when unset: `{ commit: true, quiesce: 'stop' }`. */
	snapshot?: SnapshotMeta;
	/** Optional identity hook. By default, `containerService` derives
	 * identity from the running container's id (so a recreate flips
	 * downstream cascades). Override when the meaningful change signal
	 * lives elsewhere — runtime-fetched chainId, parsed file output. */
	identity?: (ctx: LocalnetActionRunContext) => Promise<string | undefined>;
}

export function containerService<TInputs extends Record<string, unknown>>(
	opts: ContainerServiceOptions<TInputs>,
): ServiceAction<TInputs> {
	const stopOnShutdown = opts.stopOnShutdown ?? true;
	const provides = opts.provides;

	const snapshotLabels: Record<string, string> = {};
	if (opts.snapshot?.commit !== undefined) {
		snapshotLabels['devstack.snapshot.commit'] = String(opts.snapshot.commit);
	}
	if (opts.snapshot?.quiesce !== undefined) {
		snapshotLabels['devstack.snapshot.quiesce'] = opts.snapshot.quiesce;
	}

	return {
		name: opts.name,
		type: 'Service',
		needs: opts.needs,
		provides,
		inputs: opts.inputs,
		snapshotMeta: opts.snapshot,
		getStatus: async (ctx) => {
			requireLocalnetCtx(ctx);
			const cName = opts.containerName(ctx);
			const info = await inspectContainer(cName);
			if (info === null) return { ok: false, detail: 'not present' };
			if (!info.running) return { ok: false, detail: info.state };
			if (info.healthy === false) return { ok: false, detail: 'unhealthy' };
			if (opts.probe !== undefined) {
				return opts.probe(ctx, info);
			}
			return { ok: true, detail: info.healthy === true ? 'healthy' : 'running' };
		},
		run: async (ctx) => {
			requireLocalnetCtx(ctx);
			const cName = opts.containerName(ctx);
			if (stopOnShutdown) {
				ctx.onShutdown?.(async () => {
					const live = await inspectContainer(cName);
					// `restarting` state matters: a crashlooping container
					// (e.g. walrus storage node started against a stale
					// deploy file) reports `running: false` in the
					// short-lived gap between exit and the next docker
					// restart. Skipping the stop in that window leaves it
					// under `restart: unless-stopped` forever after the
					// supervisor exits. `docker stop` is a no-op on
					// already-exited containers and disables the restart
					// policy on `restarting` ones, so calling it
					// unconditionally when the container exists is the
					// safe shape.
					if (live === null) return;
					if (live.state === 'exited' || live.state === 'dead') return;
					await stopContainer(cName);
				});
			}
			const existing = await inspectContainer(cName);
			if (opts.preRun !== undefined) await opts.preRun(ctx);
			const spec = await opts.spec(ctx);
			// Stamp the reconciler's input hash on the container as a
			// label. The hash captures `inputs` plus every upstream
			// `identity` named in `needs:`, so two containers with the
			// same label were created under the same upstream context.
			// On the next cycle we compare the existing container's
			// label against the current expected hash to decide:
			//
			//   - match: upstream is unchanged → resume the existing
			//     container (`docker start` if stopped). Preserves the
			//     writable layer where stateful services hold on-disk
			//     data — walrus storage nodes' RocksDB blob store,
			//     sui-localnet's chain state under
			//     `/root/.sui/sui_config`, seal's generated cert. The
			//     reconciler only entered `run` because of either a hash
			//     mismatch (handled below) or a `getStatus` failure
			//     (e.g. container exited); resume covers the latter.
			//
			//   - mismatch: upstream drifted (sui regenesis flips
			//     chainId, walrus.deploy regenerated package IDs, …) →
			//     remove + recreate. The old writable layer references
			//     state that no longer exists on chain, so discarding
			//     it is the correct move.
			//
			// Without this, every supervisor restart unconditionally
			// removed and recreated stateful containers, wiping every
			// blob the user had uploaded.
			const inputHashLabel = 'devstack.input-hash';
			const labels = {
				...snapshotLabels,
				...spec.labels,
				[inputHashLabel]: ctx.inputHash,
			};
			const existingHash = existing?.labels?.[inputHashLabel];
			const upstreamUnchanged =
				existing !== null && existingHash === ctx.inputHash;
			if (upstreamUnchanged) {
				if (!existing.running) {
					await startContainer(cName);
				}
				// existing.running === true ⇒ already up with matching
				// upstream; nothing to do beyond the postStart probe.
			} else {
				if (existing !== null) await removeContainer(cName);
				await runContainer({ ...spec, name: cName, labels });
			}
			if (opts.postStart !== undefined) {
				await opts.postStart(ctx, cName);
			} else if (spec.healthcheck !== undefined) {
				await waitForHealthy(cName, { timeoutMs: opts.healthyTimeoutMs ?? 5 * 60_000 });
			}
		},
		// Default identity = container id. A recreate flips it; a resume
		// (`docker start` on a stopped container) keeps it stable. Plugins
		// override when the meaningful identity is something else
		// (parsed output, chainId, etc.).
		identity: async (ctx) => {
			requireLocalnetCtx(ctx);
			if (opts.identity !== undefined) return opts.identity(ctx);
			const info = await inspectContainer(opts.containerName(ctx));
			return info?.id;
		},
	};
}
