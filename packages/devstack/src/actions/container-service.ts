// `containerService()` — Service action factory for long-running Docker
// containers (sui localnet, seal key-server, walrus storage nodes).
//
// Same underlying `ServiceAction` shape as `service()`. The split exists so
// plugin authors and readers can tell at a glance: this is a managed
// container with healthcheck-aware skip semantics, NOT a host process or a
// run-once job. Conventions:
//
//   - `getStatus` should `inspectContainer` + probe an endpoint.
//   - `run` is responsible for `runContainer` / `startContainer` /
//     `removeContainer` cycles. Containers persist across `up` invocations
//     by design — no `onShutdown` hook is required (the reconciler doesn't
//     stop containers on shutdown except where the plugin explicitly opts
//     in via `onShutdown`).
//   - Pair with `provides: { registry: ... }` to populate the `services`
//     registry on warm-path skips.

import type { ActionRunContext, Provides, ServiceAction } from '../core/types.js';

export interface ContainerServiceOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function containerService<TInputs extends Record<string, unknown>>(
	opts: ContainerServiceOptions<TInputs>,
): ServiceAction<TInputs> {
	return {
		name: opts.name,
		type: 'Service',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		run: opts.run,
		getStatus: opts.getStatus,
	};
}
