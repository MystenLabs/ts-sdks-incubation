// Known mode — skip publish; load existing package id from on-chain.
//
// Distilled doc §Responsibilities + §Inputs/dependencies §KnownPackage-
// only: a `KnownPackage` declares a fixed `packageId` (optionally
// `upgradeCapId`, `mvrPlaceholder`) and threads through the same
// registries as a freshly published one. No build, no publish-tx, no
// cache key folding by content-hash — the id IS the identity.
//
// What we still do:
//
//   1. Strict verify probe (chain reachable + object exists). Strict
//      mode lets the ChainProbe distinguish an authoritative not-found
//      (`reason: 'not-found'`) from a transient RPC failure
//      (`reason: 'transient'`): only not-found surfaces a
//      PublishError(phase='verify') so the user catches the typo /
//      wrong-network mistake at boot. Transient failures are masked (no
//      abort) — the id re-verifies on the next cycle rather than failing
//      boot on a flaky RPC. A `null` strict result means "object exists
//      but isn't the expected kind"; that too is a verify failure.
//   2. Register the resolved value on EVERY cycle.
//
// Bindings: KnownPackage cannot be bound by `@mysten/codegen` (no
// source tree). The codegen contribution emitted for known packages
// has `sourcePath: null`; the codegen orchestrator filters those
// out before invoking the bindings emitter. The user-facing type
// split (`localPackage` vs `knownPackage` factories) enforces this
// at compose time per distilled doc Invariant 9.

import { Effect, Schema, type Scope } from 'effect';

import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { SuiProbeKey } from '../sui/index.ts';
import { mvrSlugify } from './dep-resolution.ts';
import { type PackageRegistry, type ResolvedKnownPackage } from './registry.ts';
import { publishError, type PublishError } from './errors.ts';

/** Verify-schema for known mode — minimum signal: object exists at
 *  the given id. */
const KnownObjectShape = Schema.Struct({
	objectId: Schema.String,
});

export interface KnownModeInputs {
	readonly packageName: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrOverride?: string;
}

export interface KnownModeOutputs {
	readonly resolved: ResolvedKnownPackage;
}

/**
 * Acquire body for known mode.
 *
 * Runs a strict ChainProbe verify and registers the resolved value.
 * Strict mode surfaces a typed `ChainProbeError` whose `reason`
 * discriminates not-found from transient, so we can fail boot on a real
 * typo / wrong-network mistake (`reason: 'not-found'`, or a `null`
 * payload meaning the id exists but is the wrong object kind) while
 * masking transient RPC failures (`reason: 'transient'`) so a flaky RPC
 * does not abort boot — the verify re-runs on the next cycle.
 */
export const acquireKnown = (
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	inputs: KnownModeInputs,
): Effect.Effect<KnownModeOutputs, PublishError, Scope.Scope> =>
	Effect.gen(function* () {
		const mvrPlaceholder = mvrSlugify(inputs.mvrOverride ?? inputs.packageName);

		const verifyError = (message: string): PublishError =>
			publishError('verify', {
				sourcePath: `known:${inputs.packageId}`,
				packageName: inputs.packageName,
				message,
			});
		// `'transient'` is a sentinel for "masked transient RPC failure —
		// skip the verify aborts and re-derive next cycle".
		const found: { readonly objectId: string } | null | 'transient' = yield* probe
			.get({ kind: 'object', objectId: inputs.packageId }, KnownObjectShape, 'strict')
			.pipe(
				// Transient RPC failure must NOT be misclassified as a typo:
				// mask it so the id re-verifies next cycle. Only an
				// authoritative not-found surfaces the verify error.
				Effect.catch((err) =>
					err.reason === 'not-found'
						? Effect.fail(
								verifyError(
									`known package id ${inputs.packageId} does not exist on this chain — check for a typo or wrong network.`,
								),
							)
						: Effect.succeed('transient' as const),
				),
			);
		// A `null` strict result means the id exists but is not the
		// expected object kind — also a verify failure.
		if (found === null) {
			return yield* Effect.fail(
				verifyError(
					`known package id ${inputs.packageId} resolved to an unexpected object shape on this chain.`,
				),
			);
		}

		const resolved: ResolvedKnownPackage = {
			kind: 'known',
			name: inputs.packageName,
			packageId: inputs.packageId,
			upgradeCapId: inputs.upgradeCapId,
			mvrPlaceholder,
		};

		// Distilled doc Invariant 6: register on EVERY cycle (here
		// always — known mode has no "miss" branch).
		yield* registry.set(resolved.name, resolved);

		return { resolved };
	});
