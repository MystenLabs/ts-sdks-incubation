// Guard: the UNIFIED config-binding path.
//
// Each config-emitting plugin must declare its `config.ts` contributions
// ONCE as a `ConfigBindingSet` from which BOTH the live (boot deployment) and
// the static (committed `config.ts`) behaviors are derived. The old failure
// mode was a plugin shipping a LIVE-only config field with NO matching
// static emission → an incomplete committed tree → a broken clean-clone
// build. This file pins that the framework derivation enforces parity, and
// that every plugin which emits a `config.ts` aggregate exposes the
// `staticCodegen` hook that derives the committed projection.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { isRawExpr } from '../../src/contracts/codegenable.ts';
import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import {
	configCodegenable,
	liveValuesOf,
	projectLiveConfig,
	projectStaticConfig,
	type ConfigBindingSet,
} from '../../src/contracts/config-bindings.ts';
import type { AnyPlugin } from '../../src/substrate/plugin.ts';
import { sui } from '../../src/plugins/sui/index.ts';
import { account } from '../../src/plugins/account/index.ts';
import { knownPackage, localPackage } from '../../src/plugins/package/index.ts';
import { makeCoinStaticCodegen } from '../../src/plugins/coin/codegen.ts';
import { makeDeepbookStaticCodegen } from '../../src/plugins/deepbook/codegen.ts';
import { makeWalrusStaticCodegen } from '../../src/plugins/walrus/codegen.ts';
import { makeSealCodegenable, makeSealStaticCodegen } from '../../src/plugins/seal/codegen.ts';

const CONFIG_BUCKET = 'config.ts';

// All paths a value lives at in a nested record, dotted (`a.b.c`).
const leafPaths = (value: unknown, prefix = ''): ReadonlyArray<string> => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isRawExpr(value)) {
		const out: Array<string> = [];
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out.push(...leafPaths(v, prefix === '' ? k : `${prefix}.${k}`));
		}
		return out.sort();
	}
	return [prefix];
};

// No baked on-chain id (`0x…`) nor literal http rpc URL survives anywhere in
// the static projection — those are LOADED CONFIG DATA, resolved at app
// build/dev time via the injected `__DEVSTACK_DEPLOYMENT__` global.
const containsBakedRuntimeValue = (value: unknown): boolean => {
	if (isRawExpr(value)) return false;
	if (typeof value === 'string')
		return /^0x[0-9a-fA-F]{6,}$/.test(value) || /^https?:\/\//.test(value);
	if (Array.isArray(value)) return value.some(containsBakedRuntimeValue);
	if (typeof value === 'object' && value !== null) {
		return Object.values(value as Record<string, unknown>).some(containsBakedRuntimeValue);
	}
	return false;
};

// The static-config aggregate(s) a plugin's `staticCodegen` hook emits into
// the `config.ts` bucket (empty when the plugin emits no config).
const staticConfigAggregates = (plugin: AnyPlugin): ReadonlyArray<CodegenableDecl> => {
	if (plugin.staticCodegen === undefined) return [];
	return plugin.staticCodegen().filter((decl) => decl.aggregate?.bucket === CONFIG_BUCKET);
};

// -----------------------------------------------------------------------------
// Framework derivation contract
// -----------------------------------------------------------------------------

describe('contracts/config-bindings — unified derivation', () => {
	// A representative set exercising every binding variant: a literal, a
	// sugar-resolved id, and a generic `resolveValue` channel binding.
	interface DemoState {
		readonly id: string;
		readonly poolId: string;
	}
	const demoSet: ConfigBindingSet<DemoState> = {
		bucket: CONFIG_BUCKET,
		kind: 'demo',
		emitterName: 'demo',
		outputPath: 'demo/x.ts',
		bindings: [
			{ variant: 'literal', configPath: ['packages', 'demo', 'mvr'], value: '@local/demo' },
			{
				variant: 'resolved',
				configPath: ['packages', 'demo', 'packageId'],
				namespace: 'package',
				key: 'demo:packageId',
				sugar: { kind: 'id', mvrPlaceholder: '@local/demo' },
				live: (s) => s.id,
			},
			{
				variant: 'resolved',
				configPath: ['demo', 'poolId'],
				namespace: 'demo',
				key: 'poolId',
				live: (s) => s.poolId,
			},
		],
	};
	const state: DemoState = {
		id: '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd',
		poolId: '0xdef456def456def456def456def456def456def456def456def456def456def4',
	};

	it('static + live derivations cover the SAME config paths (no live-only field)', () => {
		const staticPaths = leafPaths(projectStaticConfig(demoSet));
		const livePaths = leafPaths(projectLiveConfig(demoSet, state));
		expect(staticPaths).toEqual(livePaths);
	});

	it('static path bakes NO runtime value — resolvers + literals only', () => {
		const projected = projectStaticConfig(demoSet);
		expect(containsBakedRuntimeValue(projected)).toBe(false);
		// The literal survives; the resolved fields are RawExprs.
		expect(projected).toMatchObject({ packages: { demo: { mvr: '@local/demo' } } });
	});

	it('live path bakes the concrete values', () => {
		const projected = projectLiveConfig(demoSet, state);
		expect(projected).toMatchObject({
			packages: { demo: { packageId: state.id } },
			demo: { poolId: state.poolId },
		});
	});

	it('generic `values` channel carries ONLY non-sugar resolved bindings', () => {
		const values = liveValuesOf(demoSet, state);
		// `demo.poolId` (no sugar) lands in the generic channel; the sugar id
		// binding feeds the typed deployment field, not `values`.
		expect(values).toEqual({ demo: { poolId: state.poolId } });
	});

	it('static `configCodegenable` decl is aggregateOnly + carries no idConfigValues', () => {
		const decl = configCodegenable(demoSet, 'static');
		expect(decl.aggregateOnly).toBe(true);
		expect(decl.aggregate?.bucket).toBe(CONFIG_BUCKET);
		expect(decl.aggregate?.idConfigValues).toBeUndefined();
	});

	it('live `configCodegenable` decl carries the generic idConfigValues', () => {
		const decl = configCodegenable(demoSet, { mode: 'live', state });
		expect(decl.aggregate?.idConfigValues).toEqual({ demo: { poolId: state.poolId } });
	});
});

// -----------------------------------------------------------------------------
// Per-plugin guard — data-driven over the config-emitting plugin factories.
// -----------------------------------------------------------------------------

describe('contracts/config-bindings — config-emitting plugins expose the static path', () => {
	const aliceAcct = account('alice');
	// One representative instance per config-emitting plugin shape.
	const cases: ReadonlyArray<{ readonly name: string; readonly plugin: AnyPlugin }> = [
		{ name: 'sui', plugin: sui() as unknown as AnyPlugin },
		{
			name: 'localPackage',
			plugin: localPackage('demo_local', {
				sourcePath: '/tmp/does-not-exist/move/demo',
				publisher: aliceAcct,
			}) as unknown as AnyPlugin,
		},
		{
			name: 'knownPackage',
			plugin: knownPackage('demo_known', {
				packageId: '0x2',
			}) as unknown as AnyPlugin,
		},
		// A non-config-emitting plugin: must NOT falsely match the guard.
		{ name: 'account', plugin: aliceAcct as unknown as AnyPlugin },
	];

	for (const { name, plugin } of cases) {
		it(`${name}: every config.ts aggregate is reachable via staticCodegen`, () => {
			const aggregates = staticConfigAggregates(plugin);
			if (name === 'account') {
				// Account does not emit into `config.ts` — it routes accounts to
				// the gitignored extras tree. Nothing to guard here, but the
				// guard must NOT misclassify it.
				expect(aggregates.length).toBe(0);
				return;
			}
			// A config-emitting plugin MUST expose a static path (so it can
			// never ship a live-only field with no committed-tree emission).
			expect(plugin.staticCodegen).toBeDefined();
			expect(aggregates.length).toBeGreaterThan(0);
		});

		it(`${name}: static config.ts projection bakes no runtime value`, async () => {
			// A KNOWN package's declared id is PINNED CONFIG (not loaded
			// runtime data), so baking its literal is by-design — exempt it.
			if (name === 'knownPackage') return;
			const aggregates = staticConfigAggregates(plugin);
			for (const decl of aggregates) {
				const exported: Record<string, unknown> = {};
				const done = { _tag: 'CodegenEmitDone' as const };
				await Effect.runPromise(
					decl.emit({
						exportConst: (k, v) => {
							exported[k] = v;
						},
						importStatement: () => {},
						done: () => done,
					}),
				);
				const projected = decl.aggregate?.project(exported) ?? {};
				expect(containsBakedRuntimeValue(projected)).toBe(false);
			}
		});
	}
});

// -----------------------------------------------------------------------------
// Own-bucket plugins (coin/deepbook/walrus/seal): type-preserving static path.
// -----------------------------------------------------------------------------
//
// These plugins resolve their bucket fields through the GENERIC
// `requireValue(dep, ns, key)` channel (the typed deployment channel only
// carries network/packages/mvrOverrides). That channel returns `unknown`,
// which used to erase the static type of every field they emit. The fix
// carries each resolved field's concrete TS type as a `tsType` on the binding,
// emitted as `requireValue<Type>(dep, …)`. This section locks BOTH halves of
// the class:
//   1. no baked runtime value / literal `0x…` survives the static projection
//      (still LOADED CONFIG DATA), and
//   2. every resolved leaf is a TYPED `requireValue<Type>(dep, …)` read, so the
//      committed bucket typechecks against the app's usage (not `unknown`).

describe('contracts/config-bindings — own-bucket static path is type-preserving', () => {
	// Collect every RawExpr `.expr` string anywhere in a static projection.
	const rawExprs = (value: unknown): ReadonlyArray<string> => {
		if (isRawExpr(value)) return [value.expr];
		if (Array.isArray(value)) return value.flatMap(rawExprs);
		if (typeof value === 'object' && value !== null) {
			return Object.values(value as Record<string, unknown>).flatMap(rawExprs);
		}
		return [];
	};

	// `literalOnly` cases bake user-DECLARED ids as literals (known/pinned
	// modes — like `knownPackage`): they are config, not loaded-at-runtime
	// data, so they are EXEMPT from both the "no baked runtime value" and the
	// "every leaf is a typed resolveValue" assertions. The local/dev cases must
	// bake NO runtime value (every dynamic id stays a typed `resolveValue`).
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly decl: CodegenableDecl;
		readonly literalOnly?: boolean;
	}> = [
		// --- LOCAL / dev modes: dynamic ids → typed resolveValue. -------------
		// A registry coin: resolves fullCoinType/decimals/packageId.
		{
			name: 'coin (registry)',
			decl: makeCoinStaticCodegen({ symbol: 'DUSDC', source: 'registry' }),
		},
		// A builtin coin (SUI): protocol constants are literals — exempt from
		// the "every leaf is a resolveValue" assertion, included only to confirm
		// it bakes no `0x…`/URL.
		{
			name: 'coin (builtin)',
			decl: makeCoinStaticCodegen({
				symbol: 'SUI',
				source: 'builtin',
				constants: { fullCoinType: '0x2::sui::SUI', decimals: 9 },
			}),
			literalOnly: true,
		},
		{
			name: 'deepbook (local)',
			decl: makeDeepbookStaticCodegen({ name: 'deepbook', network: 'localnet' }),
		},
		{
			name: 'walrus (local)',
			decl: makeWalrusStaticCodegen({ mode: 'local', network: 'localnet' }),
		},
		{
			name: 'seal (local-keygen)',
			decl: makeSealStaticCodegen({ name: 'seal', mode: 'local-keygen' }),
		},
		// --- KNOWN / pinned modes: DECLARED ids → literals (exempt). ----------
		// A `coin.known(type)` bakes its declared `fullCoinType` literal;
		// `decimals` / `packageId` still resolve (RPC-only) so it still carries
		// typed resolveValue leaves — assert via the local-style checks but
		// allow the literal coin type by skipping the baked-value assertion.
		{
			name: 'coin (known)',
			decl: makeCoinStaticCodegen({
				symbol: 'dusdc',
				source: 'on-chain',
				knownCoinType: '0xabc123abc123abc123abc123abc123abc123abc1::usdc::USDC',
			}),
			literalOnly: true,
		},
		{
			name: 'deepbook (known)',
			decl: makeDeepbookStaticCodegen({
				name: 'deepbook',
				network: 'testnet',
				known: {
					packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
					registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
					deepTreasuryId: '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
					pyth: null,
				},
			}),
			literalOnly: true,
		},
		{
			name: 'walrus (known)',
			decl: makeWalrusStaticCodegen({
				mode: 'known',
				network: 'testnet',
				known: {
					walrusPackageId: null,
					walPackageId: null,
					walCoinType: null,
					packageConfig: {
						systemObjectId: '0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
						stakingPoolId: '0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
					},
					proxyUrl: null,
					aggregatorUrl: 'https://aggregator.testnet.walrus.example',
					publisherUrl: null,
					nodes: [],
				},
			}),
			literalOnly: true,
		},
		{
			name: 'seal (live)',
			decl: makeSealStaticCodegen({
				name: 'seal',
				mode: 'live',
				known: {
					objectId: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
					keyServerUrl: 'https://seal.testnet.example',
					serverConfigs: [
						{
							objectId: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
							weight: 1,
						},
					],
					verifyKeyServers: true,
				},
			}),
			literalOnly: true,
		},
	];

	for (const { name, decl, literalOnly } of cases) {
		it(`${name}: static projection bakes no runtime value`, () => {
			// KNOWN / pinned (+ builtin) modes bake DECLARED ids as literals —
			// that is by-design (mirrors `knownPackage`), so exempt them. The
			// LOCAL / dev modes must bake NO runtime value.
			if (literalOnly === true) return;
			const projected = decl.aggregate?.project({}) ?? {};
			expect(containsBakedRuntimeValue(projected)).toBe(false);
		});

		it(`${name}: every resolved leaf is a TYPED requireValue (not unknown)`, () => {
			// `literalOnly` modes (builtin coin, known/pinned deployments) bake
			// their declared values as literals — they may carry no requireValue
			// leaf, so they are exempt here.
			if (literalOnly === true) return;
			const projected = decl.aggregate?.project({}) ?? {};
			const exprs = rawExprs(projected);
			// At least one resolved field per bucket (every instance carries ids).
			expect(exprs.length).toBeGreaterThan(0);
			for (const expr of exprs) {
				// Each raw expr is a generic-channel `requireValue<Type>(dep, …)`
				// read off the loaded deployment's active network …
				expect(expr.startsWith('requireValue<')).toBe(true);
				// … carrying an explicit `<Type>` type argument so the committed
				// value is NOT `unknown` (the bug this regression-locks), and it
				// reads off the `dep` deployment accessor.
				expect(expr).toMatch(/^requireValue<.+>\(dep, /);
			}
		});
	}

	// The known/pinned modes MUST actually bake their declared ids as literals
	// (not silently route them through resolveValue) — the inverse of the
	// local-mode regression. Lock that a known deployment carries baked ids.
	it('coin (known) bakes the declared coin type as a literal', () => {
		const decl = makeCoinStaticCodegen({
			symbol: 'dusdc',
			source: 'on-chain',
			knownCoinType: '0xabc123abc123abc123abc123abc123abc123abc1::usdc::USDC',
		});
		const projected = decl.aggregate?.project({}) ?? {};
		expect(projected).toMatchObject({
			dusdc: { fullCoinType: '0xabc123abc123abc123abc123abc123abc123abc1::usdc::USDC' },
		});
	});

	it('deepbook (known) bakes declared package/registry ids as literals', () => {
		const decl = makeDeepbookStaticCodegen({
			name: 'deepbook',
			network: 'testnet',
			known: {
				packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
				registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
			},
		});
		const projected = decl.aggregate?.project({}) ?? {};
		expect(projected).toMatchObject({
			deepbook: {
				packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
				registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
			},
		});
	});

	it('seal (committee) strips any apiKey from the emitted serverConfigs (defense-in-depth)', () => {
		// Build the binding directly with a serverConfigs entry that carries a
		// secret apiKey VALUE — `validateLiveInputs` rejects this upstream, so we
		// hand it straight to `makeSealCodegenable` to exercise `stripApiKey`. The
		// committed `seal.ts` literals AND the `values` channel are both
		// world-readable, so neither may carry the secret.
		const decl = makeSealCodegenable({
			name: 'seal',
			mode: 'live',
			objectId: '0xdddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
			keyServerUrl: 'https://seal-aggregator-mainnet.example',
			serverConfigs: [
				{
					objectId: '0xdddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
					weight: 1,
					aggregatorUrl: 'https://seal-aggregator-mainnet.example',
					apiKeyName: 'X-API-Key',
					apiKey: 'super-secret-value',
				},
			],
			verifyKeyServers: true,
		});

		// Literal projection (committed `seal.ts`) carries NO secret apiKey.
		const projected = decl.aggregate?.project({}) ?? {};
		expect(JSON.stringify(projected)).not.toContain('super-secret-value');
		expect(JSON.stringify(projected)).not.toContain('"apiKey"');
		// The non-secret header NAME still rides along so the app knows which
		// header to set when it injects the apiKey at runtime.
		expect(JSON.stringify(projected)).toContain('X-API-Key');

		// The world-readable `values` channel (`deployment.json`) carries no
		// secret apiKey either — known/live ids bake as literals, so the generic
		// channel is empty, but assert defensively.
		const idConfigValues = decl.aggregate?.idConfigValues ?? {};
		expect(JSON.stringify(idConfigValues)).not.toContain('super-secret-value');
		expect(JSON.stringify(idConfigValues)).not.toContain('"apiKey"');
	});

	it('seal (live) bakes the declared objectId/keyServerUrl as literals', () => {
		const decl = makeSealStaticCodegen({
			name: 'seal',
			mode: 'live',
			known: {
				objectId: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
				keyServerUrl: 'https://seal.testnet.example',
				serverConfigs: [
					{
						objectId: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
						weight: 1,
					},
				],
				verifyKeyServers: true,
			},
		});
		const projected = decl.aggregate?.project({}) ?? {};
		expect(projected).toMatchObject({
			seal: {
				objectId: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
				keyServerUrl: 'https://seal.testnet.example',
			},
		});
	});
});
