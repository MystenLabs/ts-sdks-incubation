import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { layerBuiltInPluginRuntime } from '../../src/orchestrators/built-in-plugin-layers.ts';
import { CoinRegistryService } from '../../src/plugins/coin/registry.ts';
import { makeLocalPackagePublishedDecl } from '../../src/plugins/package/publish-output.ts';
import { appName, chainId, pluginKey, stackName } from '../../src/substrate/brand.ts';
import {
	CapabilitySinksService,
	type AnyContribution,
	type HarvestContext,
} from '../../src/substrate/runtime/capability-sinks/index.ts';

const harvestContext: HarvestContext = {
	pluginKey: pluginKey('package:token_pkg'),
	identity: {
		app: appName('built-in-layers-test'),
		stack: stackName('main'),
		chain: chainId('sui:localnet'),
	},
	publish: () => Effect.void,
	registerStrategy: () => Effect.void,
};

const localPackageContribution = (owner: unknown): AnyContribution =>
	({
		source: 'capability',
		decl: makeLocalPackagePublishedDecl({
			packageName: 'token_pkg',
			packageId: '0xtoken',
			chain: chainId('sui:localnet'),
			output: {
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
			},
		}) as never,
	}) satisfies AnyContribution;

describe('built-in package publish sinks', () => {
	it.effect('does not register object-owned TreasuryCaps as generic mint funding caps', () =>
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const registry = yield* CoinRegistryService;

			yield* sinks.dispatch(
				localPackageContribution({ ObjectOwner: '0xprotected' }),
				harvestContext,
			);

			const record = yield* registry.byWitness('token_pkg', 'DEEP');
			expect(record?.treasuryCapId).toBeUndefined();
			expect(record?.metadataId).toBe('0xmeta');
			expect(record?.decimals).toBe(6);
			expect(record?.symbol).toBe('DEEP');
		}).pipe(Effect.scoped, Effect.provide(layerBuiltInPluginRuntime([]))),
	);

	it.effect('registers address-owned TreasuryCaps for generic coin funding', () =>
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const registry = yield* CoinRegistryService;

			yield* sinks.dispatch(
				localPackageContribution({ AddressOwner: '0xpublisher' }),
				harvestContext,
			);

			const record = yield* registry.byWitness('token_pkg', 'DEEP');
			expect(record?.treasuryCapId).toBe('0xcap');
		}).pipe(Effect.scoped, Effect.provide(layerBuiltInPluginRuntime([]))),
	);
});
