// Regression: a pool coin that `dependsOn`/`poolCoinRefs` failed to
// resolve must surface as a TYPED `DeepbookConfigError` on the local
// plugin's error channel — NOT an uncaught defect.
//
// `requirePoolCoinValue`/`resolvePoolSpecs` previously `throw`-ed
// synchronously. Inside the local plugin's `Effect.gen` start body a
// sync throw becomes a DEFECT (a `Die` cause), which the outer
// `passthroughOrWrap` (built on `Effect.catch`, typed-channel only)
// cannot see — so the promised actionable `DeepbookConfigError` never
// reached the caller. This test drives the REAL `start` body to the
// resolution miss and asserts the exit is a recoverable `Failure`
// carrying `DeepbookConfigError`. If the throw is reintroduced, the
// exit becomes a `Die` and `Exit.findErrorOption` yields `None`, so the
// `_tag` assertion fails.
//
// The resolution miss is reached BEFORE the body yields
// `ArtifactPublisherService`, so the Effect short-circuits without
// touching any service — we drive it directly and cast the R channel to
// `never`, mirroring the `member.start([...])` idiom in `factory.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';

import { account } from '../../../src/plugins/account/index.ts';
import { coin } from '../../../src/plugins/coin/index.ts';
import { deepbook, type DeepbookResolved } from '../../../src/plugins/deepbook/index.ts';
import { localPackage } from '../../../src/plugins/package/index.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

const localMemberWithUnresolvedCoin = () => {
	const publisher = account('publisher');
	const suiCoin = coin.builtin('sui');
	const deepbookPackage = localPackage('deepbook_pkg', {
		sourcePath: 'move/deepbook',
		publisher,
		capture: {
			registryId: '::registry::Registry',
			adminCapId: '::registry::DeepbookAdminCap',
		},
	});
	return deepbook({
		mode: 'local',
		publisher,
		package: deepbookPackage,
		pools: [
			{
				name: 'SUI_SUI',
				base: { key: 'SUI', coin: suiCoin },
				quote: { key: 'SUI_QUOTE', coin: suiCoin },
				tickSize: 1_000n,
				lotSize: 1_000n,
				minSize: 1_000n,
			},
		],
	});
};

describe('deepbook local start — unresolved pool coin', () => {
	it.effect('fails with a typed DeepbookConfigError, not a defect', () =>
		Effect.gen(function* () {
			const member = localMemberWithUnresolvedCoin();

			// Hand-rolled deps: sui + publisher + package, but NO coin
			// values — so `coinValuesByRefId` is empty and the pool's base
			// coin cannot be resolved. `requireCapturedId` runs first, so
			// the package must expose valid captures to let execution reach
			// `resolvePoolSpecs`.
			const sui = { chain: 'sui:localnet', sdk: { client: {} } };
			const publisherValue = { address: '0xpub' };
			const packageValue = {
				name: 'deepbook_pkg',
				packageId: '0xpkg',
				captured: { registryId: '0xreg', adminCapId: '0xcap' },
			};

			const { ctx } = makeTestPluginCtx();
			const exit = yield* Effect.exit(
				member.start([sui, publisherValue, packageValue] as never, ctx) as Effect.Effect<
					DeepbookResolved,
					{ readonly _tag: string },
					never
				>,
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				// The cause must carry NO defect. A reintroduced sync throw
				// would surface as a `Die` here (and `findErrorOption` below
				// would be `None`).
				expect(Cause.hasDies(exit.cause)).toBe(false);

				// A typed failure (recoverable on the E channel) carrying the
				// actionable config error.
				const failure = Exit.findErrorOption(exit);
				expect(Option.isSome(failure)).toBe(true);
				if (Option.isSome(failure)) {
					const err = failure.value as {
						readonly _tag: string;
						readonly field: string;
						readonly message: string;
					};
					expect(err._tag).toBe('DeepbookConfigError');
					expect(err.field).toBe('pools');
					expect(err.message).toContain('SUI_SUI');
				}
			}
		}),
	);
});
