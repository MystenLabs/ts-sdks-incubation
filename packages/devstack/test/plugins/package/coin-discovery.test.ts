import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

// Stage B (package plugin conversion, Part 2 — the custom-kind re-home):
// local publish used to emit a custom `LOCAL_PACKAGE_PUBLISHED` decl that
// the orchestrator's `publishResultSink` (orchestrators/boot.ts)
// consumed to auto-discover coins into the per-stack `CoinRegistry`. The
// conversion lifts that discovery VERBATIM into the local package `start`
// body via the exported `discoverPublishedCoins` helper, which folds a
// fresh publish output's coins into the registry directly.
//
// This pins the load-bearing behavior at its new home: a fresh local
// publish populates the registry with the SAME records (including the
// publisher-owns-cap gate on `treasuryCapId`) the sink produced. The two
// ownership scenarios prove the move is byte-identical.

import { discoverPublishedCoins } from '../../../src/plugins/package/index.ts';
import type { LocalPackagePublishOutput } from '../../../src/plugins/package/publish-output.ts';
import { CoinRegistryService, layerCoinRegistry } from '../../../src/plugins/coin/index.ts';

const publishOutput = (owner: unknown): LocalPackagePublishOutput => ({
	digest: '0xdigest',
	packageId: '0xtoken',
	publisher: '0xpublisher',
	objectChanges: [
		{
			type: 'created',
			objectId: '0xcap',
			objectType: '0x2::coin::TreasuryCap<0xtoken::deep::DEEP>',
			owner,
		},
		{
			type: 'created',
			objectId: '0xmeta',
			objectType: '0x2::coin::CoinMetadata<0xtoken::deep::DEEP>',
			json: {
				decimals: 6,
				symbol: 'DEEP',
				name: 'DeepBook Token',
				iconUrl: 'https://images.deepbook.tech/icon.svg',
			},
		},
	],
});

describe('package local-publish coin discovery (re-homed from publishResultSink)', () => {
	it.effect('folds discovered coins into the per-stack CoinRegistry', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;

			yield* discoverPublishedCoins(
				registry,
				'token_pkg',
				'0xtoken',
				publishOutput({ AddressOwner: '0xpublisher' }),
			);

			const record = yield* registry.byWitness('token_pkg', 'DEEP');
			expect(record?.type).toBe('0xtoken::deep::DEEP');
			expect(record?.packageId).toBe('0xtoken');
			expect(record?.publishingPackageName).toBe('token_pkg');
			expect(record?.metadataId).toBe('0xmeta');
			expect(record?.decimals).toBe(6);
			expect(record?.symbol).toBe('DEEP');
			expect(record?.displayName).toBe('DeepBook Token');
		}).pipe(Effect.scoped, Effect.provide(layerCoinRegistry)),
	);

	it.effect('registers address-owned TreasuryCaps for generic coin funding', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;

			yield* discoverPublishedCoins(
				registry,
				'token_pkg',
				'0xtoken',
				publishOutput({ AddressOwner: '0xpublisher' }),
			);

			const record = yield* registry.byWitness('token_pkg', 'DEEP');
			expect(record?.treasuryCapId).toBe('0xcap');
		}).pipe(Effect.scoped, Effect.provide(layerCoinRegistry)),
	);

	it.effect('does not register object-owned TreasuryCaps as generic mint funding caps', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;

			yield* discoverPublishedCoins(
				registry,
				'token_pkg',
				'0xtoken',
				publishOutput({ ObjectOwner: '0xprotected' }),
			);

			const record = yield* registry.byWitness('token_pkg', 'DEEP');
			// Object-owned cap is gated off generic funding — only the
			// metadata-derived fields survive.
			expect(record?.treasuryCapId).toBeUndefined();
			expect(record?.metadataId).toBe('0xmeta');
			expect(record?.decimals).toBe(6);
			expect(record?.symbol).toBe('DEEP');
		}).pipe(Effect.scoped, Effect.provide(layerCoinRegistry)),
	);
});
