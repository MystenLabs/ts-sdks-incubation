// End-to-end boot of `examples/hello-world-rewrite/` against the real
// docker runtime — the smallest rewrite-track config (sui + 2
// accounts, no package, no wallet, no UI). Used as the "engine boots
// at all" smoke target.
//
// Compared to `template-boot.test.ts`:
//   - Three plugin keys instead of four (no `localPackage(hello)`).
//   - No move-build cost on cold runs; the boot only pays for the
//     sui container + per-account keypair + funding.
//
// Beyond the ready-set assertion this test pins:
//   - Faucet endpoint is reachable. After boot, an ad-hoc faucet
//     POST through the Sui plugin's auto-registered local-faucet
//     strategy returns success — proves the strategy dispatcher,
//     the faucet HTTP path, and the in-container sui-faucet binary
//     are all wired and running.
//   - Default ephemeral funding actually landed. Alice's on-chain
//     balance is non-zero after acquire (the account plugin's
//     bare-form default fires a faucet POST per the
//     `DEFAULT_EPHEMERAL_FUND_MIST` constant). If funding silently
//     skipped — a regression vector flagged in the parity matrix —
//     the assertion below catches it.
//
// Prerequisites: docker reachable on the host. Skipped by the default
// `pnpm test` run (vitest excludes `test/e2e/**` unless
// `DEVSTACK_RUN_E2E=1` is set; opt in via `pnpm test:e2e`).

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';
import type { AccountValue } from '../../src/plugins/account/service.ts';
import type { SuiClient } from '../../src/plugins/sui/index.ts';
import { faucetCapabilityKey } from '../../src/plugins/faucet/dispatcher.ts';
import type { FaucetStrategy } from '../../src/plugins/faucet/strategies/sui-local.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'hello-world-rewrite',
	'devstack.config.ts',
);

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

/** Probe the resolved `SuiGrpcClient` for an address's SUI balance.
 *  The shim's opaque `client` field is the live `SuiGrpcClient`; the
 *  SDK call is `client.core.getBalance({ owner, coinType })`. We cast
 *  through the documented shape (mirrors how the package plugin reads
 *  the same field for `Transaction.build`). Returns the balance as a
 *  bigint, or null if the SDK returned a malformed response or threw. */
const readSuiBalance = (sui: SuiClient, address: string): Effect.Effect<bigint | null, never> =>
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
			const raw = await sdkClient.core.getBalance({
				owner: address,
				coinType: '0x2::sui::SUI',
			});
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

describe('hello-world-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` against real docker', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`hello-world-boot: skipping — ${docker.detail}`);
			return;
		}

		let faucetReachable = false;
		let aliceBalance: bigint | null = null;
		let bobBalance: bigint | null = null;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'hello-world',
			stackName: 'main',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const sui = ctx.resolvedValues.get('sui#0') as SuiClient | undefined;
					const alice = ctx.resolvedValues.get('account/alice#1') as AccountValue | undefined;
					const bob = ctx.resolvedValues.get('account/bob#2') as AccountValue | undefined;

					if (sui === undefined || alice === undefined || bob === undefined) {
						return;
					}

					// 1. Faucet endpoint reachability — look up the Sui-
					//    auto-registered local strategy on the resolved
					//    chain id and POST a top-up to a fresh address.
					//    The fresh address is alice's; the dispatcher
					//    returns void on success. Any typed faucet error
					//    surfaces below as `faucetReachable = false`.
					const faucetKey = faucetCapabilityKey(sui.chain);
					const lookup = yield* ctx.strategyRegistry
						.get<typeof faucetKey, FaucetStrategy>(faucetKey)
						.pipe(Effect.exit);
					if (lookup._tag === 'Success') {
						const strategy: FaucetStrategy = lookup.value;
						const reqExit = yield* strategy
							.request({ address: alice.address, amount: 1_000_000_000n })
							.pipe(Effect.exit);
						faucetReachable = reqExit._tag === 'Success';
					}

					// 2. Default funding — read balances directly via the
					//    SDK shim. Both accounts should hold > 0 MIST
					//    because the bare-form `account('alice')` /
					//    `account('bob')` factories default to
					//    `DEFAULT_EPHEMERAL_FUND_MIST` (= 1 SUI).
					aliceBalance = yield* readSuiBalance(sui, alice.address);
					bobBalance = yield* readSuiBalance(sui, bob.address);
				}),
		});

		const expectedKeys = ['sui#0', 'account/alice#1', 'account/bob#2'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		expect(faucetReachable, 'faucet POST should succeed against the local strategy').toBe(true);
		expect(aliceBalance, 'alice balance should be readable').not.toBeNull();
		expect(bobBalance, 'bob balance should be readable').not.toBeNull();
		expect(aliceBalance!).toBeGreaterThan(0n);
		expect(bobBalance!).toBeGreaterThan(0n);
	}, 180_000);
});
