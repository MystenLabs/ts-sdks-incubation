// DeepbookConfigEmitter — covers the generated `deepbook-config.ts` shape:
//   - L1 golden against a seeded set of registries (P5.T1).
//   - L2 cache hit + full registry projection (`packageIds.DEEPBOOK_PACKAGE_ID`
//     present, output is `as const`) (P5.T2).
//   - Skip-emit branch when `services.deepbook` is absent (P5.T3).
//
// The renderConfig helpers are private, so we drive the emitter end-to-end
// via `emit(ctx)` against a tmpdir and inspect the written file.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Identity } from '../../engine/identity.js';
import {
	AccountRegistryLive,
	CoinRegistry,
	CoinRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookMarginStateRegistry,
	DeepbookMarginStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookStateRegistry,
	DeepbookStateRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
	PostgresStateRegistryLive,
	PythStateRegistry,
	PythStateRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistry,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from '../../engine/registries.js';
import { ExtrasLive } from '../../engine/extras.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { DeepbookConfigEmitter } from './deepbook-config.js';
import type { CodegenContext } from '../define-emitter.js';

const IdentityLive = Layer.succeed(Identity, {
	app: 'test-app',
	stack: 'main',
	network: 'localnet',
});

const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
	PythStateRegistryLive,
	PostgresStateRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
);

const DEEPBOOK_PACKAGE_ID = '0xdb000000000000000000000000000000000000000000000000000000000000aa';
const REGISTRY_ID = '0xdb000000000000000000000000000000000000000000000000000000000000bb';
const DEEP_TREASURY_ID = '0xdb000000000000000000000000000000000000000000000000000000000000cc';
const MUSDC_PACKAGE = '0xfe00000000000000000000000000000000000000000000000000000000000001';
const MUSDC_TYPE = `${MUSDC_PACKAGE}::mock_usdc::MOCK_USDC`;
const SUI_USDC_POOL_ID = '0xa1000000000000000000000000000000000000000000000000000000000000a1';

const PYTH_SUI_FEED = '0x50c67b3fd225db8912a424dd4baed60ffdde625ed2feaaf283724f9608fea266';
const PYTH_DEEP_FEED = '0x99137a18354efa7fb6840889d059fdb04c46a6ce21be97ab60d9ad93e91ac758';
const PYTH_SUI_PIO = '0x1ebb295c789cc42b3b2a1606482cd1c7124076a0f5676718501fda8c7fd075a0';
const PYTH_DEEP_PIO = '0x3d52fffa2cd9e54b39bb36d282bdda560b15b8b4fdf4766a3c58499ef172bafc';

const MARGIN_PKG = '0xab000000000000000000000000000000000000000000000000000000000000ab';
const LIQ_PKG = '0xab000000000000000000000000000000000000000000000000000000000000cd';
const MARGIN_REG = '0xab000000000000000000000000000000000000000000000000000000000000ef';
const MARGIN_ADMIN_CAP = '0xab00000000000000000000000000000000000000000000000000000000000099';
const MARGIN_POOL_SUI = '0xab00000000000000000000000000000000000000000000000000000000000077';

/** Seed only what every test needs to actually emit. Skip-emit tests
 *  don't call this. */
const seedBaseStack = Effect.gen(function* () {
	const eps = yield* EndpointRegistry;
	const pkgs = yield* PackageRegistry;
	const coins = yield* CoinRegistry;
	const sui = yield* SuiStateRegistry;
	const dbk = yield* DeepbookStateRegistry;

	yield* eps.register({
		name: EndpointName.SUI_RPC,
		url: 'http://sui.test-app.localhost:9000',
		kind: 'rpc',
	});
	yield* sui.register({ name: 'sui', chainId: '0xabc' });
	// The deepbook package's `captured` carries the DEEP TreasuryCap id +
	// (optionally) the registry id; the emitter's required-field check
	// reaches into both. Mirrors the local-deploy primitive's capture.
	yield* pkgs.register({
		name: 'deepbook',
		packageId: DEEPBOOK_PACKAGE_ID,
		captured: { deepTreasuryId: DEEP_TREASURY_ID, registryId: REGISTRY_ID },
	});
	yield* coins.register({
		name: 'musdc',
		type: MUSDC_TYPE,
		decimals: 6,
		sdkCoin: { address: MUSDC_PACKAGE, type: MUSDC_TYPE, scalar: 1_000_000 },
		symbol: 'MUSDC',
	});
	yield* dbk.register({
		name: 'deepbook',
		packageId: DEEPBOOK_PACKAGE_ID,
		registryId: REGISTRY_ID,
		pools: {
			sui_musdc: {
				poolId: SUI_USDC_POOL_ID,
				baseType: '0x2::sui::SUI',
				quoteType: MUSDC_TYPE,
			},
		},
	});
});

const seedPyth = Effect.gen(function* () {
	const pyth = yield* PythStateRegistry;
	yield* pyth.register({
		name: 'pyth',
		packageId: '0xfeedface',
		pythStateId: '0xfeed1111',
		wormholeStateId: '0xfeed2222',
		priceInfoObjectIds: {
			[PYTH_SUI_FEED]: PYTH_SUI_PIO,
			[PYTH_DEEP_FEED]: PYTH_DEEP_PIO,
		},
		feeds: { SUI: PYTH_SUI_FEED, DEEP: PYTH_DEEP_FEED },
	});
});

const seedMargin = Effect.gen(function* () {
	const margin = yield* DeepbookMarginStateRegistry;
	yield* margin.register({
		name: 'deepbook-margin',
		packageId: MARGIN_PKG,
		liquidationPackageId: LIQ_PKG,
		registryId: MARGIN_REG,
		adminCapId: MARGIN_ADMIN_CAP,
		marginPools: [{ label: 'SUI', assetType: '0x2::sui::SUI', marginPoolId: MARGIN_POOL_SUI }],
		registeredPools: [SUI_USDC_POOL_ID],
	});
});

describe('DeepbookConfigEmitter', () => {
	let outputDir: string;
	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'devstack-deepbook-config-'));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	const ctx = (): CodegenContext => ({ packages: [], outputDir });

	// P5.T1 — Golden against a minimal seeded set: SUI + MUSDC coins,
	// one pool, no margin, no Pyth. Output must contain the canonical
	// shape consumers spread into `client.$extend(deepbook(...))`.
	it.effect('emits deepbook-config.ts with packageIds, coins, pools, marginPools (minimal)', () =>
		Effect.gen(function* () {
			yield* seedBaseStack;
			yield* DeepbookConfigEmitter().emit(ctx());

			const filePath = joinPath(outputDir, 'deepbook-config.ts');
			const body = readFileSync(filePath, 'utf-8');

			expect(body).toContain('Generated by @mysten-incubation/devstack');
			expect(body).toContain('export const deepbookConfig = {');
			expect(body).toContain('export type DeepbookConfig = typeof deepbookConfig');
			expect(body).toContain(`DEEPBOOK_PACKAGE_ID: ${JSON.stringify(DEEPBOOK_PACKAGE_ID)}`);
			expect(body).toContain(`REGISTRY_ID: ${JSON.stringify(REGISTRY_ID)}`);
			expect(body).toContain(`DEEP_TREASURY_ID: ${JSON.stringify(DEEP_TREASURY_ID)}`);

			// Coins block — SUI + DEEP + MUSDC symbols present.
			expect(body).toContain('"SUI":');
			expect(body).toContain('"DEEP":');
			expect(body).toContain('"MUSDC":');
			expect(body).toContain(JSON.stringify(MUSDC_TYPE));

			// DEEP coin address is the deepbook package id (local-deploy bakes
			// the token sub-package under the parent address).
			expect(body).toContain(`address: ${JSON.stringify(DEEPBOOK_PACKAGE_ID)}`);

			// Pools block — alias-keyed, symbols resolved.
			expect(body).toContain('"sui_musdc":');
			expect(body).toContain(`address: ${JSON.stringify(SUI_USDC_POOL_ID)}`);
			expect(body).toContain('baseCoin: "SUI"');
			expect(body).toContain('quoteCoin: "MUSDC"');

			// No margin block when DeepbookMarginStateRegistry is empty.
			expect(body).not.toContain('MARGIN_PACKAGE_ID');
			expect(body).not.toContain('LIQUIDATION_PACKAGE_ID');

			// `marginPools: {}` still present (empty record); pyth block omitted.
			expect(body).toContain('marginPools: {}');
			expect(body).not.toContain('pyth:');

			// `as const` invariant — consumers depend on literal narrowing.
			expect(body).toContain('} as const;');
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);

	// P5.T2 — Fully-seeded registries: Pyth state, Margin, and a margin
	// pool with USDC + SUI. Output exercises every emitter branch.
	it.effect(
		'emits margin + Pyth blocks when DeepbookMarginStateRegistry + PythStateRegistry seeded',
		() =>
			Effect.gen(function* () {
				yield* seedBaseStack;
				yield* seedPyth;
				yield* seedMargin;
				yield* DeepbookConfigEmitter().emit(ctx());

				const filePath = joinPath(outputDir, 'deepbook-config.ts');
				const body = readFileSync(filePath, 'utf-8');

				// Margin package ids fold into `packageIds`.
				expect(body).toContain(`MARGIN_PACKAGE_ID: ${JSON.stringify(MARGIN_PKG)}`);
				expect(body).toContain(`MARGIN_REGISTRY_ID: ${JSON.stringify(MARGIN_REG)}`);
				expect(body).toContain(`LIQUIDATION_PACKAGE_ID: ${JSON.stringify(LIQ_PKG)}`);

				// SUI coin gains feed + priceInfoObjectId from PythStateRegistry.
				expect(body).toContain(`feed: ${JSON.stringify(PYTH_SUI_FEED)}`);
				expect(body).toContain(`priceInfoObjectId: ${JSON.stringify(PYTH_SUI_PIO)}`);

				// DEEP coin gains feed + priceInfoObjectId.
				expect(body).toContain(`feed: ${JSON.stringify(PYTH_DEEP_FEED)}`);
				expect(body).toContain(`priceInfoObjectId: ${JSON.stringify(PYTH_DEEP_PIO)}`);

				// Margin pool projection: SUI symbol-keyed with margin-pool id +
				// the asset type.
				expect(body).toContain(`address: ${JSON.stringify(MARGIN_POOL_SUI)}`);
				expect(body).toContain('"SUI":');

				// Pyth block at the bottom of the config.
				expect(body).toContain('pyth: {');
				expect(body).toContain('pythStateId: "0xfeed1111"');
				expect(body).toContain('wormholeStateId: "0xfeed2222"');
			}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);

	// P5.T3 — Cold-boot path: no services.deepbook in manifest. Emitter
	// MUST NOT write a file (a file with no DEEPBOOK_PACKAGE_ID would
	// fail at the consumer's `deepbook({...})` call).
	it.effect('skips emit when services.deepbook is absent', () =>
		Effect.gen(function* () {
			// Deliberately don't seed deepbook — only sui.
			const eps = yield* EndpointRegistry;
			yield* eps.register({
				name: EndpointName.SUI_RPC,
				url: 'http://sui.test-app.localhost:9000',
				kind: 'rpc',
			});
			yield* DeepbookConfigEmitter().emit(ctx());
			expect(existsSync(joinPath(outputDir, 'deepbook-config.ts'))).toBe(false);
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);

	// Defensive: the local-deploy primitive captures `deepTreasuryId` on
	// the deepbook Package. Without it, the SDK's swap path errors at
	// runtime ("missing DEEP_TREASURY_ID"). Skip-emit rather than write
	// a file that would fail.
	it.effect('skips emit when deepbook package is missing captured.deepTreasuryId', () =>
		Effect.gen(function* () {
			const eps = yield* EndpointRegistry;
			const pkgs = yield* PackageRegistry;
			const sui = yield* SuiStateRegistry;
			const dbk = yield* DeepbookStateRegistry;
			yield* eps.register({
				name: EndpointName.SUI_RPC,
				url: 'http://sui.test-app.localhost:9000',
				kind: 'rpc',
			});
			yield* sui.register({ name: 'sui', chainId: '0xabc' });
			// No captured: missing the DEEP TreasuryCap id.
			yield* pkgs.register({ name: 'deepbook', packageId: DEEPBOOK_PACKAGE_ID });
			yield* dbk.register({
				name: 'deepbook',
				packageId: DEEPBOOK_PACKAGE_ID,
				registryId: REGISTRY_ID,
				pools: {},
			});
			yield* DeepbookConfigEmitter().emit(ctx());
			expect(existsSync(joinPath(outputDir, 'deepbook-config.ts'))).toBe(false);
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);
});
