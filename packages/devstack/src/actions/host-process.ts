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

import type { ActionRunContext, HostProcessAction, Provides } from '../core/types.js';

interface HostProcessOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	/** Account this process signs transactions as, when applicable
	 *  (e.g. the deepbook market-maker's BalanceManager + grid txs).
	 *  Set to engage the reconciler's same-signer serialization. */
	runsAs?: string;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
}

export function hostProcess<TInputs extends Record<string, unknown>>(
	opts: HostProcessOptions<TInputs>,
): HostProcessAction<TInputs> {
	return {
		name: opts.name,
		type: 'HostProcess',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		runsAs: opts.runsAs,
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}
