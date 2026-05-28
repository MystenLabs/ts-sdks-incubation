import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import {
	ManifestExtrasInvalid,
	ManifestExtrasLookupError,
	resolveManifestExtras,
} from '../../src/substrate/manifest.ts';
import { resource } from '../../src/substrate/plugin.ts';

describe('manifest extras', () => {
	it.effect('resolves callback extras against direct member values', () =>
		Effect.gen(function* () {
			const openLobby = resource('action:connect-four.openLobby');
			const seal = resource('seal:seal');
			const extras = yield* resolveManifestExtras(
				(ctx) => {
					const lobby = ctx.value(openLobby) as { readonly objectId: string };
					const keyServer = ctx.value(seal) as {
						readonly objectId: string;
						readonly keyServerUrl: string;
					};
					return {
						openLobbyId: lobby.objectId,
						sealKeyServer: {
							objectId: keyServer.objectId,
							url: keyServer.keyServerUrl,
						},
					};
				},
				{
					value: (resource) => {
						if (resource.id === 'action:connect-four.openLobby') {
							return { objectId: '0xfeed' };
						}
						if (resource.id === 'seal:seal') {
							return { objectId: '0xseal', keyServerUrl: 'http://seal.localhost:5175' };
						}
						throw new Error(`unknown resource ${resource.id}`);
					},
				},
			);

			expect(extras).toEqual({
				openLobbyId: '0xfeed',
				sealKeyServer: {
					objectId: '0xseal',
					url: 'http://seal.localhost:5175',
				},
			});
		}),
	);

	// Regression — STYLE_GUIDE §2 rule 5: non-record extras surface a
	// tagged `ManifestExtrasInvalid` so downstream classifiers can
	// `catchTag` instead of sniffing the message.
	it.effect('fails with ManifestExtrasInvalid when extras do not resolve to a record', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				resolveManifestExtras(
					// Function returning a non-record (array) — invalid.
					() => [1, 2, 3] as unknown as Readonly<Record<string, unknown>>,
					{
						value: () => undefined,
					},
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(err._tag).toBe('Some');
			if (err._tag === 'Some') {
				expect(err.value).toBeInstanceOf(ManifestExtrasInvalid);
				expect(err.value._tag).toBe('ManifestExtrasInvalid');
			}
		}),
	);

	// Regression — `ctx.value(...)` throws `ManifestExtrasLookupError`
	// synchronously from inside the user-supplied factory.
	// `resolveManifestExtras` MUST surface that throw as a typed
	// failure (via `Effect.try`'s catch mapper), not a defect, so
	// downstream classifiers `catchTag('ManifestExtrasLookupError',
	// ...)` instead of inspecting the die-cause.
	it.effect(
		'surfaces ManifestExtrasLookupError via catchTag when ctx.value throws synchronously',
		() =>
			Effect.gen(function* () {
				const missing = resource('action:does-not-exist');
				const effect = resolveManifestExtras(
					(ctx) => {
						const value = ctx.value(missing) as { readonly objectId: string };
						return { ref: value.objectId };
					},
					{
						value: (resource) => {
							throw new ManifestExtrasLookupError({
								kind: 'unknown-resource',
								resourceId: resource.id,
							});
						},
					},
				);
				// catchTag projects the typed-error channel — if the throw
				// had become a defect this branch would never run.
				const recovered = yield* effect.pipe(
					Effect.catchTag('ManifestExtrasLookupError', (err) =>
						Effect.succeed({ caughtTag: err._tag, kind: err.kind, resourceId: err.resourceId }),
					),
				);
				expect(recovered).toEqual({
					caughtTag: 'ManifestExtrasLookupError',
					kind: 'unknown-resource',
					resourceId: 'action:does-not-exist',
				});
			}),
	);

	// Belt-and-braces: also confirm `Exit.findErrorOption` projects the
	// typed failure (not a die-cause). This is the runtime path the
	// supervisor's `runPostAcquireHook` uses to render the post-acquire
	// failure event.
	it.effect('surfaces ManifestExtrasLookupError on the typed-error channel of Exit', () =>
		Effect.gen(function* () {
			const missing = resource('action:also-missing');
			const exit = yield* Effect.exit(
				resolveManifestExtras(
					(ctx) => {
						ctx.value(missing);
						return {};
					},
					{
						value: (resource) => {
							throw new ManifestExtrasLookupError({
								kind: 'unresolved-resource',
								resourceId: resource.id,
							});
						},
					},
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(err._tag).toBe('Some');
			if (err._tag === 'Some' && err.value._tag === 'ManifestExtrasLookupError') {
				expect(err.value).toBeInstanceOf(ManifestExtrasLookupError);
				expect(err.value.kind).toBe('unresolved-resource');
			} else {
				throw new Error('expected ManifestExtrasLookupError');
			}
		}),
	);

	// Non-tagged throws from the user factory body stay defects — they
	// represent genuine programmer errors, not the expected
	// extras-lookup failure path.
	it.effect('non-tagged throws from the factory remain defects (not typed failures)', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				resolveManifestExtras(
					() => {
						throw new Error('plain programmer-error throw');
					},
					{ value: () => undefined },
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			// Typed-error channel is empty (no Fail reason for our tagged
			// errors); the cause is a Die reason carrying the raw throw.
			const err = Exit.findErrorOption(exit);
			expect(err._tag).toBe('None');
		}),
	);
});
