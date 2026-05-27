import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { ManifestExtrasInvalid, resolveManifestExtras } from '../../src/substrate/manifest.ts';
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
});
