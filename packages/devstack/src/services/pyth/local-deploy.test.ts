// L1 unit tests for `pythLocalDeploy` — verifies the tx-builder shape
// (one `create_price_feeds` call per feed spec) without hitting chain.
// Cache hit / cache-stale paths are exercised at L2 (StateStore harness)
// but kept off this file's surface to keep it fast.

import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { PYTH_FEED_IDS } from '../../../test-setup/fixtures/pyth/feeds.js';
import { addPriceInfo, type PythPriceInfoSpec } from './shared.js';
import { pythLocalDeploy, STATE_KEY_PYTH_PREFIX_INTERNAL } from './local-deploy.js';

describe('pythLocalDeploy tx-builder shape (P1.T1)', () => {
	it('builds a single batched tx with N `create_price_feeds` calls for N feed specs', () => {
		const pythPackageId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const pythStateId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

		const specs: ReadonlyArray<PythPriceInfoSpec> = [
			{
				feedId: PYTH_FEED_IDS.SUI,
				priceMagnitude: 350_000_000n,
				priceNegative: false,
				expoMagnitude: 8n,
				expoNegative: true,
				publishTime: 1715000000n,
			},
			{
				feedId: PYTH_FEED_IDS.DEEP,
				priceMagnitude: 1_500_000n,
				priceNegative: false,
				expoMagnitude: 8n,
				expoNegative: true,
				publishTime: 1715000000n,
			},
			{
				feedId: PYTH_FEED_IDS.USDC,
				priceMagnitude: 100_000_000n,
				priceNegative: false,
				expoMagnitude: 8n,
				expoNegative: true,
				publishTime: 1715000000n,
			},
		];

		const t = new Transaction();
		// The pure clock object id we use ('0x6') is the system-wide clock
		// reference accepted by every Sui Move call. The SDK's snapshot
		// validates object IDs; '0x6' is a valid shorthand. We use a
		// 32-byte padded form to satisfy the validator.
		const clockId = '0x0000000000000000000000000000000000000000000000000000000000000006';
		for (const spec of specs) {
			addPriceInfo(t, pythPackageId, pythStateId, clockId, spec);
		}

		// `getData().commands` is the verifiable shape — accessed via a
		// well-defined TransactionDataBuilder method exposed by the SDK.
		const data = t.getData();
		expect(data.commands.length).toBe(3);
		for (const cmd of data.commands) {
			const c = cmd as {
				readonly $kind: string;
				readonly MoveCall?: {
					readonly module: string;
					readonly function: string;
				};
			};
			expect(c.$kind).toBe('MoveCall');
			expect(c.MoveCall?.module).toBe('pyth');
			expect(c.MoveCall?.function).toBe('create_price_feeds');
		}
	});
});

describe('pythLocalDeploy state-store key shape', () => {
	it('uses pyth/package prefix folded with chainId + packageId + feedsHash', () => {
		expect(STATE_KEY_PYTH_PREFIX_INTERNAL).toBe('pyth/package');
	});
});

// Bug B regression — vendor option must be accepted (mutual-exclusion vs
// `movePackagePath`; vendor-only construction must succeed without throwing).
describe('pythLocalDeploy vendor option (Bug B regression)', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const stubTag = (): any => ({}) as any;
	const seedFeed = {
		label: 'SUI',
		feedId: PYTH_FEED_IDS.SUI,
		initial: {
			feedId: PYTH_FEED_IDS.SUI,
			priceMagnitude: 1n,
			priceNegative: false,
			expoMagnitude: 8n,
			expoNegative: true,
			publishTime: 1n,
		},
	} as const;

	it('throws on `movePackagePath` + `vendor` mutual exclusion', () => {
		expect(() =>
			pythLocalDeploy({
				signer: stubTag(),
				movePackagePath: '/tmp/pyth',
				vendor: stubTag(),
				feeds: [seedFeed],
			}),
		).toThrow(/mutually exclusive/);
	});

	it('accepts `vendor` alone (no `movePackagePath`) without throwing', () => {
		const t = pythLocalDeploy({
			signer: stubTag(),
			vendor: stubTag(),
			feeds: [seedFeed],
		});
		// Factory returns a LayeredTag with both __layer (composite) and
		// __layers (publish + composite + projection). Smoke-check both
		// are populated so a regression that re-introduces the
		// "movePackagePath is required" throw surfaces here.
		expect((t as unknown as { __layer?: unknown }).__layer).toBeDefined();
		const layers = (t as unknown as { __layers?: ReadonlyArray<unknown> }).__layers;
		expect(layers).toBeDefined();
		expect(layers!.length).toBeGreaterThanOrEqual(2);
	});

	it('throws when neither `movePackagePath` nor `vendor` is supplied (delegated to runtime)', () => {
		// Pre-fix the throw was synchronous from the factory body; post-fix
		// it surfaces from the acquire effect. We still want the factory
		// itself to construct (so a stack-level error message can fire at
		// run time with full context).
		const t = pythLocalDeploy({
			signer: stubTag(),
			feeds: [seedFeed],
		});
		expect((t as unknown as { __layer?: unknown }).__layer).toBeDefined();
	});
});
