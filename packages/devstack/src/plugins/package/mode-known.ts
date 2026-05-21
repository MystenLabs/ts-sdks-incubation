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
//   1. Lenient verify probe (chain reachable + object exists). On
//      transient RPC failure, lenient mode masks → no abort. On
//      authoritative not-found we surface a PublishError(phase='verify')
//      so the user catches the typo / wrong-network mistake at boot.
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
import type { SuiProbeKey } from '../sui/chain-probe.ts';
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
 * Runs the lenient ChainProbe verify and registers the resolved value.
 * Lenient mode masks transient RPC failure — the user-visible failure
 * here is "object truly missing on this chain". A `null` probe result
 * does not surface yet: distinguishing transient-vs-missing requires a
 * second strict probe layer that the ChainProbe primitive does not
 * expose.
 */
export const acquireKnown = (
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	inputs: KnownModeInputs,
): Effect.Effect<KnownModeOutputs, PublishError, Scope.Scope> =>
	Effect.gen(function* () {
		const mvrPlaceholder = mvrSlugify(inputs.mvrOverride ?? inputs.packageName);

		yield* probe
			.get({ kind: 'object', objectId: inputs.packageId }, KnownObjectShape, 'lenient')
			.pipe(
				Effect.mapError(
					(): PublishError =>
						publishError('verify', {
							sourcePath: `known:${inputs.packageId}`,
							packageName: inputs.packageName,
							message: 'verify probe failed',
						}),
				),
			);

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
