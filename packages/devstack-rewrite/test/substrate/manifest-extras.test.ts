import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { resolveManifestExtras } from '../../src/substrate/manifest.ts';

describe('manifest extras', () => {
	it.effect('resolves callback extras against direct member values', () =>
		Effect.gen(function* () {
			const openLobby = { provides: { id: 'action:arena.openLobby' } };
			const seal = { provides: { id: 'seal:seal' } };
			const extras = yield* resolveManifestExtras(
				(ctx) => {
					const lobby = ctx.use(openLobby) as { readonly objectId: string };
					const keyServer = ctx.use(seal) as {
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
					get: (tag) => {
						throw new Error(`unexpected get(${tag.id})`);
					},
					use: (member) => {
						if (member.provides.id === 'action:arena.openLobby') {
							return { objectId: '0xfeed' };
						}
						if (member.provides.id === 'seal:seal') {
							return { objectId: '0xseal', keyServerUrl: 'http://seal.localhost:5175' };
						}
						throw new Error(`unknown member ${member.provides.id}`);
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
