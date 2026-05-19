// L1 test for `pythKnownPackage` — confirms the factory resolves
// `packageId` from an override + derives per-feed PriceInfoObjects from
// `knownDeployments.deepbook.<network>.coins`.

import { Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { EngineLive } from '../../engine/engine.js';
import { PythStateRegistryLive } from '../../engine/registries.js';
import { PythTag } from './tag.js';
import { pythKnownPackage } from './known-deployment.js';

const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer, PythStateRegistryLive);

describe('pythKnownPackage (P1.T8)', () => {
	it.effect('resolves packageId + per-feed PriceInfoObjects from known testnet deployment', () =>
		Effect.gen(function* () {
			const member = pythKnownPackage({
				network: 'testnet',
				packageId: '0xabc',
				pythStateId: '0xstate',
				wormholeStateId: '0xwormhole',
			});

			const pyth = yield* Effect.gen(function* () {
				return yield* PythTag;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));

			expect(pyth.packageId).toBe('0xabc');
			expect(pyth.pythStateId).toBe('0xstate');
			expect(pyth.wormholeStateId).toBe('0xwormhole');
			// Testnet's known deployment has feeds for DEEP / SUI / DBUSDC etc.
			// `pythKnownPackage` derives PriceInfoObjects from any coin entry
			// that carries both `feed` and `priceInfoObjectId`.
			expect(pyth.priceInfos.length).toBeGreaterThan(0);
			// SUI feed should be present (testnet entry carries it).
			const suiInfo = pyth.findPriceInfoByLabel('SUI');
			expect(suiInfo).toBeDefined();
			expect(suiInfo?.feedId.startsWith('0x')).toBe(true);
			expect(suiInfo?.priceInfoObjectId.startsWith('0x')).toBe(true);
		}),
	);
});
