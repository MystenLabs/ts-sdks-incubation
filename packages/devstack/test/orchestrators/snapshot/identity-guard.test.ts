import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	IdentityContributionConflictError,
	mergeContributions,
	runIdentityGuard,
} from '../../../src/orchestrators/snapshot/identity-guard.ts';

describe('snapshot identity guard', () => {
	it.effect('rejects conflicting plugin identity contributions before restore', () =>
		Effect.gen(function* () {
			const exit = yield* mergeContributions([
				{ plugin: 'sui#0', slice: { chain: 'sui:testnet' } },
				{ plugin: 'wallet#0', slice: { chain: 'sui:mainnet' } },
			]).pipe(Effect.exit);

			expect(exit._tag).toBe('Failure');
			const error = Exit.findErrorOption(exit);
			expect(error._tag).toBe('Some');
			if (error._tag === 'Some') {
				expect(error.value).toBeInstanceOf(IdentityContributionConflictError);
				if (error.value instanceof IdentityContributionConflictError) {
					expect(error.value.key).toBe('chain');
					expect(error.value.conflictingPlugins).toEqual(['sui#0', 'wallet#0']);
					expect(error.value.values).toEqual(['sui:testnet', 'sui:mainnet']);
				}
			}
		}),
	);

	it.effect('fails closed when either side omits a contributed identity key', () =>
		Effect.gen(function* () {
			const missingLive = yield* runIdentityGuard({ chain: 'sui:testnet' }, {}).pipe(Effect.exit);
			expect(missingLive._tag).toBe('Failure');

			const missingSnapshot = yield* runIdentityGuard({}, { chain: 'sui:testnet' }).pipe(
				Effect.exit,
			);
			expect(missingSnapshot._tag).toBe('Failure');
		}),
	);
});
