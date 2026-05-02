// `containerService()` — Service action factory for long-running Docker
// containers (sui localnet, seal key-server, walrus storage nodes, etc.).
//
// Most container plugins repeat the same lifecycle: inspect → resume-or-run
// → wait-for-healthy → register-shutdown. This helper expresses that pattern
// declaratively from a `spec(ctx) => RunContainerOptions` builder, so plugin
// code stays focused on what's unique (the spec) instead of repeating the
// imperative remove+rerun dance.
//
// Pair with `provides: { registry: ... }` (or pass `registry`) to populate
// the in-memory registry on warm-path skips.

import {
	type LocalnetActionRunContext,
	type Provides,
	type ServiceAction,
	requireLocalnetCtx,
} from '../core/types.js';
import {
	type ContainerInfo,
	type RunContainerOptions,
	inspectContainer,
	removeContainer,
	runContainer,
	stopContainer,
	waitForHealthy,
} from '../plugins/sui/docker.js';

export interface ContainerServiceOptions<TInputs extends Record<string, unknown>> {
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
	/** Sugar for `provides: { registry }`. If both are set, the explicit
	 * `provides` wins. */
	registry?: (ctx: LocalnetActionRunContext) => void | Promise<void>;
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
}

export function containerService<TInputs extends Record<string, unknown>>(
	opts: ContainerServiceOptions<TInputs>,
): ServiceAction<TInputs> {
	const stopOnShutdown = opts.stopOnShutdown ?? true;
	const userRegistry = opts.registry;
	const provides: Provides | undefined =
		opts.provides ??
		(userRegistry !== undefined
			? {
					registry: (ctx) => {
						requireLocalnetCtx(ctx);
						return userRegistry(ctx);
					},
				}
			: undefined);

	return {
		name: opts.name,
		type: 'Service',
		needs: opts.needs,
		provides,
		inputs: opts.inputs,
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
					if (live?.running === true) await stopContainer(cName);
				});
			}
			const existing = await inspectContainer(cName);
			if (existing !== null) {
				await removeContainer(cName);
			}
			if (opts.preRun !== undefined) await opts.preRun(ctx);
			const spec = await opts.spec(ctx);
			await runContainer({ ...spec, name: cName });
			if (opts.postStart !== undefined) {
				await opts.postStart(ctx, cName);
			} else if (spec.healthcheck !== undefined) {
				await waitForHealthy(cName, { timeoutMs: opts.healthyTimeoutMs ?? 5 * 60_000 });
			}
		},
	};
}
