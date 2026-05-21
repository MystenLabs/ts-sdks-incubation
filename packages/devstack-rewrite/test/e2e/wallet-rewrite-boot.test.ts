// End-to-end boot of `examples/wallet-rewrite/` against the real
// docker runtime — the canonical "real-world dapp dev" config:
//
//   - sui()
//   - account('publisher')  — package publisher + treasury cap holder
//   - account('alice'), account('bob'), account('carol')
//   - localPackage('mock_usdc', { publisher })
//   - localPackage('mock_weth', { publisher })
//   - coin.witness(mock_usdc, 'MOCK_USDC')
//   - coin.witness(mock_weth, 'MOCK_WETH')
//   - action('wallet.seedTokens', ...) — mints to each recipient
//   - wallet({ accounts: [publisher, alice, bob, carol] })
//
// What this test pins beyond `ready`:
//
//   1. The wallet's `WalletValue.url` is reachable. A bare GET against
//      `/api/v1/devstack/health` returns 200 (the unauthenticated
//      health endpoint per `WalletHttpPath.HEALTH`). Proves the
//      wallet's HTTP server bound the port the port-broker handed it
//      and is serving requests.
//
//   2. The PR4-2 `seedTokens` action body that the wallet config
//      collapsed (mint→transfer for each (coin, recipient) pair) ran
//      end-to-end against the booted sui container. After boot, each
//      of alice/bob/carol holds the expected USDC + WETH amounts on-
//      chain. Probes via `client.core.getBalance({owner, coinType})`.
//
// The seed amounts come from the config's `USDC_AMOUNTS` / `WETH_AMOUNTS`
// constants — pinned here so a config drift surfaces as a test diff
// rather than silently passing.
//
// Prerequisites: docker reachable on the host. Cold runs pay the sui
// container start (60-80s) + two move builds (usdc + weth, ~10-20s
// each) + ~6 sequential mint transactions. 240s timeout to absorb the
// cold path.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';
import type { AccountValue } from '../../src/plugins/account/service.ts';
import type { CoinValue } from '../../src/plugins/coin/service.ts';
import type { SuiClient } from '../../src/plugins/sui/index.ts';
import type { WalletValue } from '../../src/plugins/wallet/service.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'wallet-rewrite',
	'devstack.config.ts',
);

// Mirror of the config's distribution constants. Keeping these here
// (rather than re-importing from the example) makes a config drift
// surface as a localized diff in this test. Order: [alice, bob, carol].
const USDC_AMOUNTS = [75_000_000_000n, 10_000_000_000n, 5_000_000_000n] as const;
const WETH_AMOUNTS = [6_000_000_000n, 500_000_000n, 200_000_000n] as const;

const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

/** Probe the resolved `SuiClient` for an address's balance under a
 *  specific coin type. Mirrors the hello-world-boot helper but lets
 *  the caller specify a non-default coin type. Returns the balance
 *  as a bigint, or null if the SDK returned a malformed response or
 *  threw. */
const readBalance = (
	sui: SuiClient,
	address: string,
	coinType: string,
): Effect.Effect<bigint | null, never> =>
	Effect.tryPromise({
		try: async () => {
			const sdkClient = sui.sdk.client as {
				readonly core: {
					readonly getBalance: (args: {
						readonly owner: string;
						readonly coinType?: string;
					}) => Promise<{ readonly balance?: string | bigint } | unknown>;
				};
			};
			const raw = await sdkClient.core.getBalance({ owner: address, coinType });
			if (raw === null || typeof raw !== 'object') return null;
			const b = (raw as { balance?: unknown }).balance;
			if (typeof b === 'bigint') return b;
			if (typeof b === 'string') {
				try {
					return BigInt(b);
				} catch {
					return null;
				}
			}
			return null;
		},
		catch: () => null as bigint | null,
	}).pipe(Effect.catch(() => Effect.succeed<bigint | null>(null)));

/** Bare-bones HTTP probe of the wallet's health endpoint. Avoids
 *  threading a fetch implementation through Effect — the boot-driver
 *  callback context doesn't expose one, and the native `fetch` is
 *  fine for a single-shot reachability check. */
const probeWalletHealth = (url: string): Effect.Effect<number | null, never> =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(`${url}/api/v1/devstack/health`);
			return res.status;
		},
		catch: () => null as number | null,
	}).pipe(Effect.catch(() => Effect.succeed<number | null>(null)));

describe('wallet-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready`, wallet endpoint is reachable, seedTokens funded recipients', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`wallet-rewrite-boot: skipping — ${docker.detail}`);
			return;
		}

		let walletHealthStatus: number | null = null;
		let aliceUsdc: bigint | null = null;
		let bobUsdc: bigint | null = null;
		let carolUsdc: bigint | null = null;
		let aliceWeth: bigint | null = null;
		let bobWeth: bigint | null = null;
		let carolWeth: bigint | null = null;
		let usdcType: string | null = null;
		let wethType: string | null = null;
		let walletUrl: string | null = null;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'wallet-rewrite',
			stackName: 'main',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const sui = ctx.resolvedValues.get('sui#0') as SuiClient | undefined;
					const alice = ctx.resolvedValues.get('account/alice#2') as AccountValue | undefined;
					const bob = ctx.resolvedValues.get('account/bob#3') as AccountValue | undefined;
					const carol = ctx.resolvedValues.get('account/carol#4') as AccountValue | undefined;
					const mUsdc = ctx.resolvedValues.get('coin:mock_usdc#7') as CoinValue | undefined;
					const mWeth = ctx.resolvedValues.get('coin:mock_weth#8') as CoinValue | undefined;
					const wallet = ctx.resolvedValues.get('wallet#10') as WalletValue | undefined;

					if (
						sui === undefined ||
						alice === undefined ||
						bob === undefined ||
						carol === undefined ||
						mUsdc === undefined ||
						mWeth === undefined ||
						wallet === undefined
					) {
						return;
					}

					walletUrl = wallet.url;
					usdcType = mUsdc.fullCoinType;
					wethType = mWeth.fullCoinType;

					// 1. Wallet endpoint reachability.
					walletHealthStatus = yield* probeWalletHealth(wallet.url);

					// 2. Per-recipient balances. `seedTokens` minted USDC
					//    + WETH to each of alice/bob/carol from the
					//    publisher's treasury cap.
					aliceUsdc = yield* readBalance(sui, alice.address, mUsdc.fullCoinType);
					bobUsdc = yield* readBalance(sui, bob.address, mUsdc.fullCoinType);
					carolUsdc = yield* readBalance(sui, carol.address, mUsdc.fullCoinType);
					aliceWeth = yield* readBalance(sui, alice.address, mWeth.fullCoinType);
					bobWeth = yield* readBalance(sui, bob.address, mWeth.fullCoinType);
					carolWeth = yield* readBalance(sui, carol.address, mWeth.fullCoinType);
				}),
		});

		// Eleven-plugin expectation. Ordinals match the variadic
		// position in `examples/wallet-rewrite/devstack.config.ts`:
		//   sui(0), publisher(1), alice(2), bob(3), carol(4),
		//   usdc(5), weth(6), mUSDC(7), mWETH(8), seedTokens(9),
		//   wallet(10).
		const expectedKeys = [
			'sui#0',
			'account/publisher#1',
			'account/alice#2',
			'account/bob#3',
			'account/carol#4',
			'package:mock_usdc#5',
			'package:mock_weth#6',
			'coin:mock_usdc#7',
			'coin:mock_weth#8',
			'action:wallet.seedTokens#9',
			'wallet#10',
		];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Wallet endpoint.
		expect(walletUrl, 'wallet resolved value missing url').toBeTruthy();
		expect(walletUrl!).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(walletHealthStatus, 'wallet /health should be reachable').toBe(200);

		// fullCoinType pinned via tag (rejects sentinel placeholders).
		expect(usdcType).toBeTruthy();
		expect(wethType).toBeTruthy();
		expect(usdcType!).not.toMatch(/<unresolved/);
		expect(wethType!).not.toMatch(/<unresolved/);

		// Per-recipient balances exactly match the distribution. The
		// `seedTokens` action mints precisely the amounts in
		// `USDC_AMOUNTS` / `WETH_AMOUNTS`; nothing else in the stack
		// touches these coin types, so the on-chain balance equals
		// the minted amount.
		expect(aliceUsdc, 'alice USDC balance should be readable').not.toBeNull();
		expect(bobUsdc, 'bob USDC balance should be readable').not.toBeNull();
		expect(carolUsdc, 'carol USDC balance should be readable').not.toBeNull();
		expect(aliceWeth, 'alice WETH balance should be readable').not.toBeNull();
		expect(bobWeth, 'bob WETH balance should be readable').not.toBeNull();
		expect(carolWeth, 'carol WETH balance should be readable').not.toBeNull();

		expect(aliceUsdc!).toBe(USDC_AMOUNTS[0]);
		expect(bobUsdc!).toBe(USDC_AMOUNTS[1]);
		expect(carolUsdc!).toBe(USDC_AMOUNTS[2]);
		expect(aliceWeth!).toBe(WETH_AMOUNTS[0]);
		expect(bobWeth!).toBe(WETH_AMOUNTS[1]);
		expect(carolWeth!).toBe(WETH_AMOUNTS[2]);
	}, 240_000);
});
