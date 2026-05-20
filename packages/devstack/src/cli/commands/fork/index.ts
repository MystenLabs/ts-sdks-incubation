// `devstack fork <sub>` — operator-facing surface for fork-mode stacks.
//
// All subcommands target the running stack's `sui-fork` container by:
//   1. Resolving the active stack name (precedence: `--stack` >
//      DEVSTACK_STACK > .devstack/active > 'main').
//   2. Reading the stack's `manifest.json` to discover the fork's gRPC
//      endpoint (`services.sui.rpc.url`).
//   3. Constructing a `SuiGrpcClient` against that URL — its
//      `forkingService` is the admin RPC client we need for `status`,
//      `advanceClock`, `advanceCheckpoint`, and `replayTo`.
//
// Subcommands:
//
//   status                      Print `forkedAtCheckpoint`, current
//                               `checkpointSequenceNumber`, `epoch`,
//                               `timestampMs`. `--json` for scripting.
//   advance-clock <durationMs>  Advance the on-chain clock by ms.
//   advance-checkpoint          Seal pending txs into a new checkpoint;
//                               `--count N` advances N times.
//   replay-to <checkpoint>      Repeatedly `advance-checkpoint` until
//                               the local sequence number reaches the
//                               target. Useful when running a script
//                               against a specific checkpoint anchor.
//   seed list                   Dump the on-disk meta.json's
//                               seedAddresses + seedObjects.
//   seed diff                   Compare on-disk meta.json against the
//                               configHash of a freshly-parsed
//                               devstack.config.ts. Exit 0 on match,
//                               1 on diff.
//   cache list                  Walk `.devstack/sui-fork-cache/` and
//                               report per-chainId size.
//   cache prune --unreferenced  Remove every cache entry not currently
//                               referenced by an active fork stack.
//
// Audit E20 (notes/stack-simplification-audit.md:231) called out the
// 917 LoC monolith; this directory split + the `_shared.ts` resolve-
// stack/build-client/wrap-RPC helpers collapse the boilerplate.

import { Command } from 'effect/unstable/cli';
import {
	collectCacheEntries,
	collectReferencedChainIds,
} from '../../../engine/sui-fork/cache-inventory.js';
import { resolveForkMetaPath as resolveEngineForkMetaPath } from '../../../engine/sui-fork/meta.js';
import { advanceCheckpointCommand, advanceClockCommand } from './advance.js';
import { cacheCommand } from './cache.js';
import { replayToCommand } from './replay.js';
import { seedCommand } from './seed.js';
import { resolveForkRuntimeCtx } from './_shared.js';
import { statusCommand } from './status.js';

export const forkCommand = Command.make('fork').pipe(
	Command.withDescription(
		'Inspect + drive `sui-fork`-backed stacks (status, advance-*, seed, cache)',
	),
	Command.withSubcommands([
		statusCommand,
		advanceClockCommand,
		advanceCheckpointCommand,
		replayToCommand,
		seedCommand,
		cacheCommand,
	]),
);

/** Re-exported helper for tests that want to construct a status-style
 *  payload without going through the CLI parser. */
export const _internal = {
	resolveForkRuntimeCtx,
	resolveEngineForkMetaPath,
	collectReferencedChainIds,
	collectCacheEntries,
};
