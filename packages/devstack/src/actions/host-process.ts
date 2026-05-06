// `hostProcess()` — HostProcess action factory for in-process subprocesses
// (vite dev-server, the wallet-server HTTP listener).
//
// Returns a `HostProcessAction` (type: 'HostProcess'), discriminated from
// `ServiceAction` (docker containers detached from the supervisor) so
// test-setup paths like `applyTestSetupFilter` can drop them: a Playwright
// globalSetup that runs HostProcess actions starts servers that immediately
// die when globalSetup returns. Conventions:
//
//   - `getStatus` typically probes a local URL (HEAD / GET).
//   - `run` spawns the child and registers an `onShutdown` hook that
//     gracefully terminates it (SIGTERM → SIGKILL fallback).
//   - The factory enforces nothing beyond the type discriminator; it's a
//     typed wrapper that makes intent explicit at call sites and gives
//     filters something to pattern-match on.

// HostProcess actions are localnet-only by construction (the filters in
// `cli/filters.ts` drop them on live-net cycles). Reflect that in the
// type system: `run` / `getStatus` / `identity` callbacks receive
// `LocalnetActionRunContext` directly so plugin code reads `ctx.stack`,
// `ctx.ports`, etc. without `requireLocalnetCtx(ctx)`. The factory casts
// to the wider `ActionRunContext`-receiving shape because
// `HostProcessAction.run` is part of the `Action` union.

import type { HostProcessAction, LocalnetActionRunContext, Provides } from '../core/types.js';
import { mergeRegistryShortcut } from '../core/types.js';

interface HostProcessOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Sugar for `provides: { registry }`. */
	registry?: (ctx: LocalnetActionRunContext) => Promise<void> | void;
	inputs: TInputs;
	/** Account this process signs transactions as, when applicable
	 *  (e.g. the deepbook market-maker's BalanceManager + grid txs).
	 *  Set to engage the reconciler's same-signer serialization. */
	runsAs?: string;
	run: (ctx: LocalnetActionRunContext) => Promise<void>;
	getStatus?: (ctx: LocalnetActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: LocalnetActionRunContext) => Promise<string | undefined>;
}

export function hostProcess<TInputs extends Record<string, unknown>>(
	opts: HostProcessOptions<TInputs>,
): HostProcessAction<TInputs> {
	return {
		name: opts.name,
		type: 'HostProcess',
		needs: opts.needs,
		provides: mergeRegistryShortcut(opts.provides, opts.registry),
		inputs: opts.inputs,
		runsAs: opts.runsAs,
		run: opts.run as HostProcessAction<TInputs>['run'],
		getStatus: opts.getStatus as HostProcessAction<TInputs>['getStatus'],
		identity: opts.identity as HostProcessAction<TInputs>['identity'],
	};
}
