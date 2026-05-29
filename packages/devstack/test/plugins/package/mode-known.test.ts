// Known-package mode — strict-verify not-found-vs-transient pinning.
//
// `acquireKnown` runs a STRICT ChainProbe verify against the declared
// `packageId`. The strict surface returns a typed `ChainProbeError`
// whose `reason` discriminates an authoritative `'not-found'` (the id
// is a typo / wrong network) from a transient RPC failure
// (`'transient'`). The classifier wiring is load-bearing:
//
//   - `reason: 'not-found'` MUST surface `PublishError('verify')` so the
//     user catches the mistake at boot.
//   - `reason: 'transient'` MUST be masked (NO abort) so a flaky RPC
//     does not fail boot — the id re-verifies next cycle.
//   - a `null` strict payload (object exists but wrong kind) is also a
//     `PublishError('verify')`.
//
// We drive `acquireKnown` through a stubbed `ChainProbe` that yields
// each reason and pin the resulting outcome.

import { Effect, Exit, Option, type Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../../src/contracts/chain-probe.ts';
import type { SuiProbeKey } from '../../../src/plugins/sui/chain-probe.ts';
import { acquireKnown } from '../../../src/plugins/package/mode-known.ts';
import type { PublishError } from '../../../src/plugins/package/errors.ts';
import {
	PackageRegistryService,
	layerPackageRegistry,
} from '../../../src/plugins/package/registry.ts';

/** Probe that always FAILS strict-mode with the supplied reason — the
 *  classifier under test sits on the `acquireKnown` side of this
 *  boundary. */
const failingProbe = (reason: ChainProbeError['reason']): ChainProbe<SuiProbeKey> => ({
	get: <Shape>(
		_key: SuiProbeKey,
		_schema: ChainProbeSchema<Shape>,
		_mode: ChainProbeMode,
	): Effect.Effect<Shape | null, ChainProbeError> =>
		Effect.fail({
			_tag: 'ChainProbeError',
			reason,
			chain: 'sui:localnet',
			detail: `stub ${reason}`,
		}),
});

/** Probe that resolves a strict payload (or `null` for the
 *  wrong-object-kind case). */
const resolvingProbe = (value: { readonly objectId: string } | null): ChainProbe<SuiProbeKey> => ({
	get: <Shape>(
		_key: SuiProbeKey,
		_schema: ChainProbeSchema<Shape>,
		_mode: ChainProbeMode,
	): Effect.Effect<Shape | null, ChainProbeError> => Effect.succeed(value as Shape | null),
});

const KNOWN_INPUTS = {
	packageName: 'my_pkg',
	packageId: '0xknownpkg',
} as const;

describe('acquireKnown — strict verify classifier', () => {
	it.effect("not-found surfaces PublishError('verify') (typo / wrong network aborts boot)", () =>
		Effect.gen(function* () {
			const registry = yield* PackageRegistryService;
			const exit = yield* Effect.scoped(
				acquireKnown(failingProbe('not-found'), registry, KNOWN_INPUTS) as Effect.Effect<
					unknown,
					PublishError,
					Scope.Scope
				>,
			).pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const errorOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errorOpt)).toBe(true);
			const error = Option.getOrThrow(errorOpt);
			expect(error._tag).toBe('PublishError');
			expect(error.phase).toBe('verify');
			expect(error.packageName).toBe('my_pkg');
			expect(error.message).toContain('does not exist on this chain');

			// Negative: a failed verify must NOT register the id.
			const registered = yield* registry.find('my_pkg');
			expect(registered).toBeNull();
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('transient does NOT abort — id is registered and re-verifies next cycle', () =>
		Effect.gen(function* () {
			const registry = yield* PackageRegistryService;
			const result = yield* Effect.scoped(
				acquireKnown(failingProbe('transient'), registry, KNOWN_INPUTS),
			);

			// Masked transient → known mode still resolves + registers.
			expect(result.resolved.kind).toBe('known');
			expect(result.resolved.packageId).toBe('0xknownpkg');
			const registered = yield* registry.find('my_pkg');
			expect(registered?.kind).toBe('known');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect("a null strict payload (wrong object kind) surfaces PublishError('verify')", () =>
		Effect.gen(function* () {
			const registry = yield* PackageRegistryService;
			const exit = yield* Effect.scoped(
				acquireKnown(resolvingProbe(null), registry, KNOWN_INPUTS) as Effect.Effect<
					unknown,
					PublishError,
					Scope.Scope
				>,
			).pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Option.getOrThrow(Exit.findErrorOption(exit));
			expect(error._tag).toBe('PublishError');
			expect(error.phase).toBe('verify');
			expect(error.message).toContain('unexpected object shape');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('a present object resolves + registers cleanly', () =>
		Effect.gen(function* () {
			const registry = yield* PackageRegistryService;
			const result = yield* Effect.scoped(
				acquireKnown(resolvingProbe({ objectId: '0xknownpkg' }), registry, KNOWN_INPUTS),
			);
			expect(result.resolved.packageId).toBe('0xknownpkg');
			const registered = yield* registry.find('my_pkg');
			expect(registered?.kind).toBe('known');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);
});
