// End-to-end boot of `examples/private-content/` — the
// local Walrus + local Seal vault stack. Scoped to
// boot + resolved-value invariants; full vault encrypt/decrypt
// roundtrip lives in the example's Playwright spec.
//
// Stack shape (per `examples/private-content/devstack.config.ts`):
//   - sealPublisher = account('seal_publisher') with SUI funding only
//   - publisher     = account('publisher') with SUI + WAL funding
//   - alice         = account('alice') with SUI + WAL funding
//   - bob           = account('bob') with SUI + WAL funding
//   - vault         = localPackage('vault', { publisher: sealPublisher })
//   - walrus({ local: { nodeCount: 4 }})
//   - walCoin(walrusCluster)
//   - seal({ mode: 'local-keygen', signer: sealPublisher })
//   - wallet({ accounts: [publisher, alice, bob] })
//
// The example's happy path targets the real vendored walrus + seal
// binaries against the real upstream Move sources. This test supplies
// test-owned override fixtures: pre-built stub images for both services
// and an on-disk stub Move package for Seal.
//
// What this test pins:
//
//   1. Every plugin member reaches `ready` — explicit sui + walrus service +
//      WAL coin ref + 4 accounts + vault package + seal service + wallet.
//      Eleven keys total.
//   2. Resolved values are fully projected; the recursive walker reports
//      the first sentinel path if projection regresses.
//   3. The walrus + seal resolved values are well-formed: walrus
//      packageConfig.systemObjectId / stakingPoolId are real 0x-hex
//      ids, proxy/aggregator/publisher URLs are http(s); seal
//      objectId is a real 0x-hex id, keyServerUrl matches the routed
//      `seal-key-server` endpoint.
//   4. The wallet accepts the example's Vite origin, matching the
//      browser app's pairing policy.
//
// DEFERRED — explicitly out of scope for this test, tracked
// elsewhere:
//
//   - Full vault roundtrip: encrypt small payload via seal IBE,
//     store/read ciphertext via the Walrus SDK, then decrypt via the
//     seal key-server `/v1/fetch_key`. The SDK publish/register legs
//     are wired; the remaining work is a dedicated programmatic
//     driver that imports generated bindings and performs the signed
//     upload/grant/decrypt transaction flow.
//   - Snapshot save → kill → restore roundtrip across the full
//     local services. `runBoot` now provides registration-level snapshot
//     wiring; the remaining gap is the full save/restore roundtrip.
//
// Prerequisites: docker reachable on the host. Soft-skips otherwise.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';

import {
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WalletHttpPath,
} from '../../src/plugins/wallet/protocol.ts';
import type { WalletValue } from '../../src/plugins/wallet/service.ts';
import { dockerReachable, pruneManagedImagesForApp } from './docker-prune.ts';
import { runBoot, type BootResult } from './boot-config-impl.ts';

const PRIVATE_CONTENT_APP_ORIGIN =
	'http://dev.private-content.private-content.localhost:5175' as const;
const PRIVATE_CONTENT_APP_PORT = 5170;
// The app this boot runs under (`runBoot({ appName: PRIVATE_CONTENT_APP })`).
const PRIVATE_CONTENT_APP = 'private-content';
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'private-content',
	'devstack.config.ts',
);

const WALRUS_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'walrus-stub');
const SEAL_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'seal-stub');
const WALRUS_STUB_IMAGE_TAG = 'walrus-test-stub:latest';
const SEAL_STUB_IMAGE_TAG = 'seal-test-stub:latest';

const SEAL_STUB_MOVE_DIR = resolve(HERE, 'fixtures', 'seal-stub');

const buildStubImage = (
	tag: string,
	dockerfileDir: string,
): { readonly ok: boolean; readonly detail: string } => {
	const res = spawnSync('docker', ['build', '-t', tag, dockerfileDir], {
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (res.status !== 0) {
		return {
			ok: false,
			detail: `docker build ${tag} failed (status=${res.status}):\n${res.stdout}\n${res.stderr}`,
		};
	}
	return { ok: true, detail: '' };
};

/** Recursive sentinel walker — shared shape with
 *  Returns the first matching path + value so the assertion message
 *  points at the offending field; `null` means clean. */
const SENTINEL_PATTERNS: ReadonlyArray<RegExp> = [/<unresolved/];
const findSentinel = (
	value: unknown,
	path: string = '$',
	seen: WeakSet<object> = new WeakSet(),
): { readonly path: string; readonly value: string } | null => {
	if (typeof value === 'string') {
		if (SENTINEL_PATTERNS.some((p) => p.test(value))) return { path, value };
		return null;
	}
	if (value === null || typeof value !== 'object') return null;
	if (seen.has(value as object)) return null;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = findSentinel(value[i], `${path}[${i}]`, seen);
			if (hit !== null) return hit;
		}
		return null;
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		// Skip function-valued fields (resolved values carry closures
		// like signer.signAndExecute, walrus.publisher.put) — they are
		// not user-visible config and would never carry a sentinel.
		if (typeof v === 'function') continue;
		const hit = findSentinel(v, `${path}.${k}`, seen);
		if (hit !== null) return hit;
	}
	return null;
};

const walletKey = 'wallet#9' as const;

const expectedKeys = [
	'sui#0',
	'account/seal_publisher#1',
	'package:vault#2',
	'walrus:walrus',
	'seal:seal',
	'coin:wal#5',
	'account/publisher#6',
	'account/alice#7',
	'account/bob#8',
	walletKey,
	'host-service/app#10',
	// The example config composes `dashboard()` as the final member
	// (examples/private-content/devstack.config.ts) — it reaches ready as #11.
	// (This fixture previously omitted it, so the test was failing on a stray
	// dashboard#11 key independent of any source change.)
	'dashboard#11',
];

interface PrivateContentBoot {
	readonly result: BootResult;
	readonly walletHealth: WalletHealthProbe;
	readonly accountFunding: Readonly<Record<string, AccountFundingEvidence>>;
}

interface WalletHealthProbe {
	readonly status: number | null;
	readonly body: string;
	readonly url: string;
	readonly origin: string;
	readonly attempts: ReadonlyArray<WalletHealthAttempt>;
}

interface WalletHealthAttempt {
	readonly origin: string;
	readonly status: number | null;
	readonly body: string;
}

interface AccountFundingEvidence {
	readonly sui: bigint;
	readonly wal: bigint;
	readonly funding: AccountFundingState;
}

interface AccountFundingState {
	readonly requested: ReadonlyArray<AccountFundingEntry>;
	readonly applied: ReadonlyArray<AccountFundingEntry>;
}

interface AccountFundingEntry {
	readonly coin: string;
	readonly fullCoinType: string;
	readonly amount: string | bigint | number;
}

interface WalrusBootValue {
	readonly mode: 'local' | 'known';
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly nodes: ReadonlyArray<unknown>;
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly walCoinType: string | null;
}

interface SealBootValue {
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<{
		readonly objectId: string;
		readonly weight: number;
	}>;
}

interface BalanceReader {
	readonly sdk: {
		readonly client: {
			readonly getBalance: (args: {
				readonly owner: string;
				readonly coinType: string;
			}) => Promise<{ readonly balance?: { readonly balance?: unknown } | unknown }>;
		};
	};
}

const sealPublisherKey = 'account/seal_publisher#1' as const;
const walletAccountKeys = ['account/publisher#6', 'account/alice#7', 'account/bob#8'] as const;
const accountKeys = [sealPublisherKey, ...walletAccountKeys] as const;
const SUI_COIN_TYPE = '0x2::sui::SUI';
const WARM_RESTART_BUDGET_MS = 120_000;

const bigintBalance = (value: unknown): bigint => {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return BigInt(value);
	if (typeof value === 'string' && value.length > 0) return BigInt(value);
	return 0n;
};

const sdkBalanceAmount = (response: { readonly balance?: unknown }): bigint => {
	const balance = response.balance;
	if (typeof balance === 'object' && balance !== null && 'balance' in balance) {
		return bigintBalance((balance as { readonly balance?: unknown }).balance);
	}
	return bigintBalance(balance);
};

const runPrivateContentBoot = async (opts: {
	readonly runtimeRoot: string;
	readonly routerStateRoot: string;
}): Promise<PrivateContentBoot> => {
	let walletHealth: WalletHealthProbe = {
		status: null,
		body: 'not probed',
		url: '',
		origin: PRIVATE_CONTENT_APP_ORIGIN,
		attempts: [],
	};
	let accountFunding: Readonly<Record<string, AccountFundingEvidence>> = {};
	const result = await runBoot({
		configPath: CONFIG_PATH,
		appName: PRIVATE_CONTENT_APP,
		stackName: 'private-content',
		runtimeRoot: opts.runtimeRoot,
		routerStateRoot: opts.routerStateRoot,
		withinScope: (ctx) =>
			Effect.gen(function* () {
				const wallet = ctx.resolvedValues.get(walletKey) as WalletValue | undefined;
				if (wallet === undefined) return;
				walletHealth = yield* Effect.promise(async () => {
					const url = `http://127.0.0.1:${wallet.localPort}${WalletHttpPath.HEALTH}`;
					const origins = [
						PRIVATE_CONTENT_APP_ORIGIN,
						'http://dev.private-content.localhost:5175',
						`http://dev.private-content.private-content.localhost:${PRIVATE_CONTENT_APP_PORT}`,
						`http://localhost:${PRIVATE_CONTENT_APP_PORT}`,
					] as const;
					const attempts: WalletHealthAttempt[] = [];
					for (const origin of origins) {
						try {
							const res = await fetch(url, {
								headers: {
									[WALLET_AUTH_HEADER]: `${WALLET_BEARER_PREFIX}${wallet.token}`,
									origin,
								},
							});
							const body = await res.text();
							attempts.push({ origin, status: res.status, body });
							if (res.status === 200) {
								return {
									status: res.status,
									body,
									url,
									origin,
									attempts,
								};
							}
						} catch (cause) {
							attempts.push({
								origin,
								status: null,
								body: cause instanceof Error ? cause.message : String(cause),
							});
						}
					}
					const first = attempts[0];
					if (first !== undefined) {
						return {
							status: first.status,
							body: first.body,
							url,
							origin: first.origin,
							attempts,
						};
					}
					return {
						status: null,
						body: 'not probed',
						url,
						origin: PRIVATE_CONTENT_APP_ORIGIN,
						attempts,
					};
				});

				const sui = ctx.resolvedValues.get('sui#0') as BalanceReader | undefined;
				const wal = ctx.resolvedValues.get('coin:wal#5') as
					| { readonly fullCoinType?: unknown }
					| undefined;
				if (sui === undefined || typeof wal?.fullCoinType !== 'string') return;
				const walCoinType = wal.fullCoinType;
				accountFunding = yield* Effect.promise(async () => {
					const entries = await Promise.all(
						accountKeys.map(async (key) => {
							const account = ctx.resolvedValues.get(key) as
								| { readonly address?: unknown; readonly funding?: unknown }
								| undefined;
							if (typeof account?.address !== 'string') {
								return [
									key,
									{
										sui: 0n,
										wal: 0n,
										funding: { requested: [], applied: [] },
									},
								] as const;
							}
							const [suiBalance, walBalance] = await Promise.all([
								sui.sdk.client.getBalance({ owner: account.address, coinType: SUI_COIN_TYPE }),
								sui.sdk.client.getBalance({
									owner: account.address,
									coinType: walCoinType,
								}),
							]);
							return [
								key,
								{
									sui: sdkBalanceAmount(suiBalance),
									wal: sdkBalanceAmount(walBalance),
									funding: accountFundingState(account.funding),
								},
							] as const;
						}),
					);
					return Object.fromEntries(entries);
				});
			}),
	});
	return { result, walletHealth, accountFunding };
};

const accountFundingState = (value: unknown): AccountFundingState => {
	if (typeof value !== 'object' || value === null) {
		return { requested: [], applied: [] };
	}
	const funding = value as {
		readonly requested?: unknown;
		readonly applied?: unknown;
	};
	return {
		requested: accountFundingEntries(funding.requested),
		applied: accountFundingEntries(funding.applied),
	};
};

const accountFundingEntries = (value: unknown): ReadonlyArray<AccountFundingEntry> =>
	Array.isArray(value)
		? value.flatMap((entry) => {
				if (typeof entry !== 'object' || entry === null) return [];
				const item = entry as {
					readonly coin?: unknown;
					readonly fullCoinType?: unknown;
					readonly amount?: unknown;
				};
				if (
					typeof item.coin !== 'string' ||
					typeof item.fullCoinType !== 'string' ||
					!(
						typeof item.amount === 'string' ||
						typeof item.amount === 'bigint' ||
						typeof item.amount === 'number'
					)
				) {
					return [];
				}
				return [
					{
						coin: item.coin,
						fullCoinType: item.fullCoinType,
						amount: item.amount,
					},
				];
			})
		: [];

const fundingAmount = (amount: string | bigint | number): string => amount.toString();

const hasFundingEntry = (
	entries: ReadonlyArray<AccountFundingEntry>,
	coin: string,
	fullCoinType: string,
	amount: string,
): boolean =>
	entries.some(
		(entry) =>
			entry.coin === coin &&
			entry.fullCoinType === fullCoinType &&
			fundingAmount(entry.amount) === amount,
	);

const assertPrivateContentBoot = (boot: PrivateContentBoot): void => {
	const { result, walletHealth } = boot;
	expect(result.failures).toEqual([]);
	expect(result.topLevelErrorCount).toBe(0);
	expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());
	expect(
		walletHealth.status,
		`wallet health ${walletHealth.url} attempts: ${walletHealth.attempts
			.map((a) => `${a.origin} -> ${a.status}: ${a.body}`)
			.join(' | ')}`,
	).toBe(200);
	expect(walletHealth.origin).toBe(PRIVATE_CONTENT_APP_ORIGIN);

	for (const [key, resolved] of result.resolvedValues) {
		const hit = findSentinel(resolved, `$${key}`);
		expect(hit, hit === null ? '' : `sentinel found at ${hit.path}: ${hit.value}`).toBeNull();
	}

	const walrus = walrusValue(result);
	expect(walrus.mode).toBe('local');
	expect(walrus.nodes.length).toBe(4);
	expect(walrus.walrusPackageId).toMatch(/^0x[0-9a-f]+$/i);
	expect(walrus.walPackageId).toMatch(/^0x[0-9a-f]+$/i);
	expect(walrus.walCoinType).toBe(`${walrus.walPackageId}::wal::WAL`);
	expect(walrus.packageConfig.systemObjectId).toMatch(/^0x[0-9a-f]+$/i);
	expect(walrus.packageConfig.stakingPoolId).toMatch(/^0x[0-9a-f]+$/i);
	expect(walrus.proxyUrl).toMatch(/^https?:\/\//);
	expect(walrus.aggregatorUrl).toMatch(/^https?:\/\//);
	expect(walrus.publisherUrl).toMatch(/^https?:\/\//);

	const seal = sealValue(result);
	expect(seal.objectId).toMatch(/^0x[0-9a-f]+$/i);
	expect(seal.keyServerUrl).toBe(
		'http://key-server.private-content.private-content.localhost:2024',
	);
	expect(seal.serverConfigs.length).toBeGreaterThanOrEqual(1);
	for (const cfg of seal.serverConfigs) {
		expect(cfg.objectId).toMatch(/^0x[0-9a-f]+$/i);
		expect(cfg.weight).toBeGreaterThan(0);
	}

	const sealPublisherFunding = boot.accountFunding[sealPublisherKey];
	expect(
		sealPublisherFunding,
		`${sealPublisherKey} funding evidence should be present`,
	).toBeDefined();
	expect(
		sealPublisherFunding!.sui,
		`${sealPublisherKey} should have SUI after account funding`,
	).toBeGreaterThan(0n);
	expect(
		hasFundingEntry(sealPublisherFunding!.funding.requested, 'SUI', SUI_COIN_TYPE, '1000000000'),
	).toBe(true);
	expect(
		sealPublisherFunding!.funding.requested.some((entry) => entry.coin === 'WAL'),
		`${sealPublisherKey} should not request WAL funding`,
	).toBe(false);
	expect(
		sealPublisherFunding!.funding.applied.some((entry) => entry.coin === 'WAL'),
		`${sealPublisherKey} should not apply WAL funding`,
	).toBe(false);

	for (const key of walletAccountKeys) {
		const funding = boot.accountFunding[key];
		expect(funding, `${key} funding evidence should be present`).toBeDefined();
		expect(funding!.sui, `${key} should have SUI after account funding`).toBeGreaterThan(0n);
		expect(hasFundingEntry(funding!.funding.requested, 'SUI', SUI_COIN_TYPE, '1000000000')).toBe(
			true,
		);
		expect(
			hasFundingEntry(funding!.funding.requested, 'WAL', walrus.walCoinType ?? '', '500000000'),
		).toBe(true);
		if (
			walrus.walCoinType !== null &&
			hasFundingEntry(funding!.funding.applied, 'WAL', walrus.walCoinType, '500000000')
		) {
			expect(funding!.wal, `${key} should have WAL after WAL account funding`).toBeGreaterThan(0n);
		}
	}
};

const walrusValue = (result: BootResult): WalrusBootValue => {
	const walrus = result.resolvedValues.get('walrus:walrus') as WalrusBootValue | undefined;
	expect(walrus, 'walrus resolved value should be present').toBeDefined();
	return walrus!;
};

const sealValue = (result: BootResult): SealBootValue => {
	const seal = result.resolvedValues.get('seal:seal') as SealBootValue | undefined;
	expect(seal, 'seal resolved value should be present').toBeDefined();
	return seal!;
};

const walletValue = (result: BootResult): WalletValue => {
	const wallet = result.resolvedValues.get('wallet#9') as WalletValue | undefined;
	expect(wallet, 'wallet resolved value should be present').toBeDefined();
	return wallet!;
};

const chainIdValue = (result: BootResult): string => {
	const sui = result.resolvedValues.get('sui#0') as { readonly chain?: unknown } | undefined;
	expect(sui, 'sui resolved value should be present').toBeDefined();
	expect(sui!.chain, 'sui resolved value should carry a chain id').toEqual(expect.any(String));
	return sui!.chain as string;
};

interface PackageBootValue {
	readonly packageId: string;
}

const packageValue = (result: BootResult, key: string): PackageBootValue => {
	const pkg = result.resolvedValues.get(key) as PackageBootValue | undefined;
	expect(pkg, `${key} resolved value should be present`).toBeDefined();
	expect(pkg!.packageId, `${key} should carry a packageId`).toMatch(/^0x[0-9a-f]+$/i);
	return pkg!;
};

const accountAddress = (values: ReadonlyMap<string, unknown>, key: string): string => {
	const account = values.get(key) as { readonly address?: unknown } | undefined;
	expect(account, `${key} resolved value should be present`).toBeDefined();
	expect(account!.address, `${key} should carry an address`).toEqual(expect.any(String));
	const address = account!.address as string;
	expect(address).toMatch(/^0x[0-9a-f]+$/i);
	return address;
};

describe('private-content boots end-to-end @e2e', () => {
	// Sweep the managed build/snapshot images this boot minted (under
	// `appName: PRIVATE_CONTENT_APP`, across the cold + warm boots). Label-scoped
	// so it can only reap images THIS test created, never the user's stacks.
	afterAll(() => pruneManagedImagesForApp(PRIVATE_CONTENT_APP));

	it('every plugin reaches `ready` on cold boot and warm restart', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`private-content-boot: skipping — ${docker.detail}`);
			return;
		}

		const walrusBuild = buildStubImage(WALRUS_STUB_IMAGE_TAG, WALRUS_STUB_DOCKERFILE_DIR);
		expect(walrusBuild.ok, walrusBuild.detail).toBe(true);
		const sealBuild = buildStubImage(SEAL_STUB_IMAGE_TAG, SEAL_STUB_DOCKERFILE_DIR);
		expect(sealBuild.ok, sealBuild.detail).toBe(true);

		// Trust-the-tag fast paths in the cargo-image resolvers
		// (`walrus/bootstrap-assets/cargo-image.ts` +
		//  `seal/bootstrap-assets/cargo-image.ts`).
		process.env.WALRUS_CARGO_IMAGE_OVERRIDE = WALRUS_STUB_IMAGE_TAG;
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = SEAL_STUB_IMAGE_TAG;
		// Trust-the-path fast path in Seal's move-source resolver. The
		// override path is treated as the Move package root (Move.toml
		// + sources/) directly.
		process.env.SEAL_MOVE_SOURCE_OVERRIDE = SEAL_STUB_MOVE_DIR;

		const runtimeRoot = mkdtempSync(join(tmpdir(), 'private-content-warm-runtime-'));
		const routerStateRoot = mkdtempSync(join(tmpdir(), 'private-content-warm-router-'));

		const coldStartMs = performance.now();
		const cold = await runPrivateContentBoot({ runtimeRoot, routerStateRoot });
		const coldDurationMs = performance.now() - coldStartMs;
		assertPrivateContentBoot(cold);

		const warmStartMs = performance.now();
		const warm = await runPrivateContentBoot({ runtimeRoot, routerStateRoot });
		const warmDurationMs = performance.now() - warmStartMs;
		assertPrivateContentBoot(warm);
		expect(
			warmDurationMs,
			`warm restart took ${Math.round(warmDurationMs)}ms after cold boot took ${Math.round(coldDurationMs)}ms`,
		).toBeLessThan(WARM_RESTART_BUDGET_MS);

		expect(warm.result.runtimeRoot).toBe(cold.result.runtimeRoot);
		expect(warm.result.routerDispatchDir).toBe(cold.result.routerDispatchDir);
		expect(walletValue(warm.result).token).toBe(walletValue(cold.result).token);
		for (const key of accountKeys) {
			expect(accountAddress(warm.result.resolvedValues, key)).toBe(
				accountAddress(cold.result.resolvedValues, key),
			);
		}
		expect(walrusValue(warm.result).walCoinType).toBe(walrusValue(cold.result).walCoinType);
		expect(walrusValue(warm.result).packageConfig).toEqual(walrusValue(cold.result).packageConfig);

		// Decryption-critical identities: a warm restart MUST reuse the
		// cold-boot deployment, not republish. If the Sui chain
		// re-genesis'd (unclean container exit) or the artifact-publisher's
		// lenient verify forced a re-publish on a transient RPC blip, these
		// ids drift — and any content encrypted/stored against the cold-boot
		// deployment becomes permanently undecryptable. This is the
		// regression guard for the "can't decrypt old content after a
		// restart" failure; without it the test above passes even while
		// every id silently churns.
		expect(chainIdValue(warm.result), 'Sui chainId must survive a warm restart').toBe(
			chainIdValue(cold.result),
		);
		expect(
			packageValue(warm.result, 'package:vault#2').packageId,
			'vault packageId (Seal policy + seal_approve target) must survive a warm restart',
		).toBe(packageValue(cold.result, 'package:vault#2').packageId);
		expect(
			sealValue(warm.result).objectId,
			'Seal key-server objectId must survive a warm restart',
		).toBe(sealValue(cold.result).objectId);
		expect(
			sealValue(warm.result).serverConfigs.map((cfg) => cfg.objectId),
			'Seal serverConfigs objectIds must survive a warm restart',
		).toEqual(sealValue(cold.result).serverConfigs.map((cfg) => cfg.objectId));
		expect(
			walrusValue(warm.result).walrusPackageId,
			'walrus package id must survive a warm restart',
		).toBe(walrusValue(cold.result).walrusPackageId);
		expect(walrusValue(warm.result).walPackageId, 'WAL package id must survive a warm restart').toBe(
			walrusValue(cold.result).walPackageId,
		);
	}, 600_000);
});
