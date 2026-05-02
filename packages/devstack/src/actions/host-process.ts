// `hostProcess()` — Service action factory for in-process subprocesses
// (vite dev-server, the wallet-server HTTP listener).
//
// Same underlying `ServiceAction` shape as `service()`. The split exists so
// readers can see at a glance: this is a host-side child process with
// signal-driven teardown, NOT a managed container. Conventions:
//
//   - `getStatus` typically probes a local URL (HEAD / GET).
//   - `run` spawns the child and registers an `onShutdown` hook that
//     gracefully terminates it (SIGTERM → SIGKILL fallback).
//   - The factory enforces nothing beyond documentation; it's a typed
//     wrapper that makes intent explicit at call sites.

import type { ActionRunContext, Provides, ServiceAction } from '../core/types.js';

export interface HostProcessOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function hostProcess<TInputs extends Record<string, unknown>>(
	opts: HostProcessOptions<TInputs>,
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
