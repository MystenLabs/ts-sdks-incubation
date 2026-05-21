// Sui plugin — fork mode.
//
// An in-stack sui-fork binary running against a captured snapshot
// of an upstream live network at a frozen checkpoint, advancing
// only via explicit admin RPCs. Used to develop against real
// on-chain state without paying gas or waiting on real consensus.
//
// What's hard (from the distilled doc — abridged):
//   - Write-once seed-manifest contract; config drift between
//     boots panics the binary with a non-actionable error. We
//     mirror the gate at the supervisor layer with an actionable
//     error BEFORE the binary starts (`ensureForkMetaConsistent`).
//   - Two fork processes against the same data dir silently
//     trample each other's RocksDB; a cross-process file lock on
//     the data dir is mandatory (`acquireForkDataLock`).
//   - The SDK's `client.core.{getBalance, listBalances, getCoinInfo}`
//     panic the fork binary; intercepted at property-access level
//     via `wrapWithForkGuard`.
//   - Cold start serially fetches upstream state via GraphQL;
//     readiness deadline is much longer than local mode (180s).
//   - The fork's chain id IS the upstream's REAL chain id —
//     wallet-standard validation and MVR think they're on the real
//     chain.
//   - Auto-tick clock advancement is a supervisor-side knob,
//     log-and-continue on failure.
//   - Seed objects from `KnownPackage` declarations must be
//     auto-merged into the fork's seed flags at acquire time
//     (`seed-objects.ts` accumulator).
//   - Walrus / Seal / Deepbook "local cluster" variants are
//     incompatible with fork mode; the type system catches this
//     via mode-narrowed factories. Runtime defense-in-depth raises
//     a typed error at compose time.

import { Duration, Effect, type Scope } from 'effect';

import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
import { resolveAutoTickIntervalMs } from '../auto-tick.ts';
import { suiPluginError, type SeedManifestMismatchError, type SuiPluginError } from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import type { SuiClient } from './shared.ts';
import type { SuiForkOptions } from './spec.ts';

/** Default ready-probe timeout for fork-mode cold start. */
export const DEFAULT_FORK_READY_TIMEOUT = Duration.seconds(180);

/** Default sui-fork commit SHA pinned by the bundled image.
 *  Distilled-doc opportunity: this is duplicated between
 *  test-side and production-side with a "bump in lockstep" comment
 *  but no CI enforcement. The redesign should pick one canonical
 *  source. */
export const DEFAULT_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930';

/** Default gas budget stamped onto impersonated txs that don't set
 *  one explicitly (architecture invariant: "Empty-signature
 *  impersonation MUST stamp a default gas budget"). */
export const DEFAULT_FORK_GAS_BUDGET = 100_000_000n;

/** Map upstream literal to the canonical "live" chain id known by
 *  wallet-standard / MVR. The fork acquires this id and publishes
 *  it as `NetworkConfig.chain` so downstream lookups think they're
 *  on the real chain. */
export const FORK_UPSTREAM_TO_KNOWN_NETWORK = {
	mainnet: 'sui:mainnet',
	testnet: 'sui:testnet',
	devnet: 'sui:devnet',
} as const;

/** Resolved fork-mode boot artifacts. */
export interface ForkModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
	/** Auto-tick handle — preserved (not discarded) so a future
	 *  cadence-change surface has a join point. Architecture
	 *  opportunity. */
	readonly autoTickIntervalMs: number | undefined;
}

/**
 * Build the fork-mode boot Effect.
 *
 * Order is load-bearing (distilled-doc invariant):
 *   1. Acquire the data-dir file lock.
 *   2. Run the meta-consistency gate.
 *   3. Start the fork container (after both pass).
 *   4. Probe `ForkingService.GetStatus` with the fork ready
 *      deadline.
 *   5. Resolve the upstream's chain id from the SDK.
 *   6. Build the SDK with the fork guard wrapper.
 *   7. Optionally fork the auto-tick clock fiber.
 *
 * Reversing any pair is unsafe.
 *
 * Auto-tick option validation runs eagerly so a misconfigured stack
 * fails synchronously at compose. The container + lock + meta wiring
 * is not implemented in this branch yet — the body raises a typed
 * `container-start` error so the supervisor surfaces an actionable
 * row rather than silently succeeding.
 */
export const bootForkMode = (
	_runtime: ContainerRuntime,
	opts: SuiForkOptions,
): Effect.Effect<ForkModeBootResult, SuiPluginError | SeedManifestMismatchError, Scope.Scope> =>
	Effect.gen(function* () {
		const autoTickIntervalMs = resolveAutoTickIntervalMs(opts.autoTick);

		return yield* Effect.fail<SuiPluginError>(
			suiPluginError(
				'container-start',
				`sui fork mode: not implemented in this branch ` +
					`(upstream=${opts.upstream} autoTick=${String(autoTickIntervalMs)})`,
			),
		);
	});
