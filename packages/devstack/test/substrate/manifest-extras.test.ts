import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { resolveManifestExtras } from '../../src/substrate/manifest.ts';
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
});
