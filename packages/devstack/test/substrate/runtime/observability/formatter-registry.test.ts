// FormatterRegistryService — harvest + cascade-formatter integration.
//
// Architecture invariants under test:
//   1. `register` adds tags to the registry; `snapshot` returns an
//      immutable `FormatterRegistry` the cascade formatter consumes.
//   2. The cascade formatter consults the registry when rendering a
//      tagged error whose `_tag` matches.
//   3. Scope close reaps registrations — `snapshot` no longer carries
//      the contribution's formatters afterwards.
//   4. Multi-plugin registrations for overlapping tags last-write-wins
//      on the formatter slot.

import { Cause, Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	FormatterRegistryService,
	formatCause,
	layerFormatterRegistry,
} from '../../../../src/substrate/runtime/observability/index.ts';
import type { PluginErrorContribution } from '../../../../src/substrate/plugin.ts';

const contribA: PluginErrorContribution = {
	_tag: 'PluginErrorContribution',
	errorTags: ['SuiPluginError', 'SuiCliError'],
	formatter: (value) => {
		const phase = value['phase'];
		return typeof phase === 'string' ? `[SUI ${phase}] ${value._tag}` : null;
	},
};

const contribB: PluginErrorContribution = {
	_tag: 'PluginErrorContribution',
	errorTags: ['WalrusError'],
	// No formatter — registry just tracks the tag for diagnostics; the
	// cascade-formatter falls back to default rendering.
};

describe('FormatterRegistryService', () => {
	it.effect('register stores tags and snapshot returns matching formatters', () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const fmt = yield* FormatterRegistryService;
					yield* fmt.register(contribA);
					yield* fmt.register(contribB);
					const snap = yield* fmt.snapshot;
					expect(snap.has('SuiPluginError')).toBe(true);
					// WalrusError is registered but not in `snapshot` because
					// no formatter was provided — snapshot only contains
					// entries with an actual formatter.
					expect(snap.has('WalrusError')).toBe(false);
				}),
			);
		}).pipe(Effect.provide(layerFormatterRegistry)),
	);

	it.effect('cascade formatter consults the harvested registry', () =>
		Effect.gen(function* () {
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const fmt = yield* FormatterRegistryService;
					yield* fmt.register(contribA);
					const snap = yield* fmt.snapshot;
					// Build a cause carrying a SuiPluginError-shaped value.
					const cause = Cause.fail({
						_tag: 'SuiPluginError',
						phase: 'rpc-probe',
						message: 'probe failed',
					});
					return formatCause(cause, { formatters: snap });
				}),
			);
			expect(result).toContain('[SUI rpc-probe] SuiPluginError');
		}).pipe(Effect.provide(layerFormatterRegistry)),
	);

	it.effect('scope close drops the contribution from the registry', () =>
		Effect.gen(function* () {
			const layerStable = layerFormatterRegistry;
			yield* Effect.gen(function* () {
				const fmt = yield* FormatterRegistryService;

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* fmt.register(contribA);
						const snap = yield* fmt.snapshot;
						expect(snap.has('SuiPluginError')).toBe(true);
					}),
				);
				// After the inner scope closes, the registrations must be
				// reaped — same outer service, empty snapshot.
				const snapAfter = yield* fmt.snapshot;
				expect(snapAfter.size).toBe(0);
			}).pipe(Effect.provide(layerStable));
		}),
	);

	it.effect('last-write-wins on overlapping formatter slots', () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const fmt = yield* FormatterRegistryService;
					yield* fmt.register({
						_tag: 'PluginErrorContribution',
						errorTags: ['SharedError'],
						formatter: () => 'FIRST',
					});
					yield* fmt.register({
						_tag: 'PluginErrorContribution',
						errorTags: ['SharedError'],
						formatter: () => 'SECOND',
					});
					const snap = yield* fmt.snapshot;
					const renderer = snap.get('SharedError')!;
					expect(renderer({ _tag: 'SharedError' }, () => '')).toBe('SECOND');
				}),
			);
		}).pipe(Effect.provide(layerFormatterRegistry)),
	);
});
