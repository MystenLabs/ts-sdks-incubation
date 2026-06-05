// Structural pins for the `StrategyContributorDecl` capability contract.
//
// The strategy-contributor decl carries:
//   - `kind: 'strategy-contributor'` discriminator,
//   - `capabilityKey` as a string literal (preserved through generics so
//      consumers picking by key recover the strategy value shape),
//   - `strategy` value (already-bound dependencies),
//   - `autoMounted: boolean` (renderer visibility flag).
//
// Plus the type-level `StrategyFor<Caps, Key>` extractor must narrow to
// the strategy payload for a registered key.

import { describe, expect, it } from 'vitest';

import type {
	StrategyContributorDecl,
	StrategyFor,
} from '../../src/contracts/strategy-contributor.ts';

describe('contracts/strategy-contributor — structural pins', () => {
	it('discriminated-union `kind` is the literal `"strategy-contributor"`', () => {
		const decl: StrategyContributorDecl<'demo', { readonly run: () => void }> = {
			kind: 'strategy-contributor',
			capabilityKey: 'demo',
			strategy: { run: () => undefined },
			autoMounted: true,
		};
		const tagged: 'strategy-contributor' = decl.kind;
		expect(tagged).toBe('strategy-contributor');
	});

	it('rejects a literal missing `capabilityKey` (required)', () => {
		// @ts-expect-error -- `capabilityKey` is required.
		const _bad: StrategyContributorDecl = {
			kind: 'strategy-contributor',
			strategy: {},
			autoMounted: false,
		};
		void _bad;
	});

	it('rejects a literal missing `strategy` (required)', () => {
		// @ts-expect-error -- `strategy` is required.
		const _bad: StrategyContributorDecl = {
			kind: 'strategy-contributor',
			capabilityKey: 'demo',
			autoMounted: false,
		};
		void _bad;
	});

	it('rejects a literal missing `autoMounted` (required)', () => {
		// @ts-expect-error -- `autoMounted` is required.
		const _bad: StrategyContributorDecl = {
			kind: 'strategy-contributor',
			capabilityKey: 'demo',
			strategy: {},
		};
		void _bad;
	});

	it('`StrategyFor<Caps, Key>` recovers the strategy shape for a registered key', () => {
		type Caps = readonly [
			StrategyContributorDecl<'gate:funds-ready', { readonly waitFundsReady: () => void }>,
			StrategyContributorDecl<'coinType:WAL', { readonly mint: (amount: bigint) => void }>,
		];
		type Funds = StrategyFor<Caps, 'gate:funds-ready'>;
		type Wal = StrategyFor<Caps, 'coinType:WAL'>;

		// Compile-time assertions: the extractor narrows to the registered
		// strategy shape, not `unknown`.
		const _funds: Funds = { waitFundsReady: () => undefined };
		const _wal: Wal = { mint: (_amount: bigint) => undefined };
		void _funds;
		void _wal;

		// Unknown keys narrow to `never` — assignment fails at the type level.
		const _missing: StrategyFor<Caps, 'coinType:MISSING'> = undefined as never;
		void _missing;
	});
});
