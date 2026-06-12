// Live-stack spec: create → increment → read a shared Counter against the
// stack `pnpm dev` keeps running (the suite deliberately shares it —
// everything here is additive). A throwaway keypair funded by the local
// faucet signs real transactions through the generated bindings.

import { getStackContext, useDevstackTestSetup } from '@mysten-incubation/devstack/vitest';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DEV_HINT = 'start the stack with `pnpm dev` and keep it running, then re-run `pnpm test`';

// `requireDevstack: true` makes `beforeAll` throw a clear "run `devstack up`"
// error when the stack has never been booted (no manifest on disk). A stopped
// stack leaves its last manifest behind, so the wrapped hook also probes the
// RPC endpoint — both failure modes point at `pnpm dev` instead of a raw
// fetch error mid-test. `silent` skips the use-a-separate-test-stack
// advisory, since sharing the dev stack is this suite's point.
useDevstackTestSetup(
	{
		afterAll,
		beforeAll: (hook) =>
			beforeAll(async () => {
				try {
					await hook();
				} catch (cause) {
					throw new Error(`no devstack manifest found — ${DEV_HINT}`, { cause });
				}
				const rpcUrl = endpoint('rpc');
				const probe = await fetch(rpcUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => {
					throw new Error(`devstack manifest found, but ${rpcUrl} is not responding — ${DEV_HINT}`);
				});
				// The devstack router outlives individual stacks and answers routed
				// hostnames even when this stack is down — a dead backend surfaces as
				// an HTTP error status, not a network failure. (A live gRPC rpc
				// answers a bare GET with 405.)
				if (probe.status === 404 || probe.status >= 502) {
					throw new Error(
						`devstack manifest found, but the stack behind ${rpcUrl} is not running (HTTP ${probe.status}) — ${DEV_HINT}`,
					);
				}
			}),
	},
	{ requireDevstack: true, silent: true },
);

function endpoint(name: string): string {
	const url = getStackContext()?.endpoint(name);
	if (url === undefined) {
		throw new Error(`stack manifest exposes no '${name}' endpoint — ${DEV_HINT}`);
	}
	return url;
}

describe('counter (live devstack)', () => {
	it('creates a shared Counter and increments it', { timeout: 30_000 }, async () => {
		// Imported dynamically: these modules only exist after the first
		// `devstack up` / `apply`, and a static import would fail at collection
		// before the friendly beforeAll error could surface.
		const { config } = await import('@generated/config.js');
		const { createCounterTx, executedTx, incrementTx, readCounter } = await import('./counter.js');

		const client = new SuiGrpcClient({
			network: 'localnet',
			baseUrl: endpoint('rpc'),
			// Resolves the bindings' default `@local/counter` package name to the
			// deployed id at tx-build time (same wiring as `dapp-kit.ts`).
			mvr: { overrides: { packages: config.mvrOverrides } },
		});

		// Throwaway on-chain actor, funded by the stack's local faucet.
		const signer = new Ed25519Keypair();
		const grant = await requestSuiFromFaucetV2({
			host: endpoint('faucet'),
			recipient: signer.toSuiAddress(),
		});
		await Promise.all(
			(grant.coins_sent ?? []).map(({ transferTxDigest }) =>
				client.waitForTransaction({ digest: transferTxDigest }),
			),
		);

		const create = executedTx(
			await client.signAndExecuteTransaction({
				transaction: createCounterTx(),
				signer,
				include: { effects: true },
			}),
		);
		if (create.createdId === undefined) throw new Error('create_and_share created no object');
		await client.waitForTransaction({ digest: create.digest });
		expect(await readCounter(client, create.createdId)).toBe(0n);

		const increment = executedTx(
			await client.signAndExecuteTransaction({
				transaction: incrementTx(create.createdId),
				signer,
				include: { effects: true },
			}),
		);
		await client.waitForTransaction({ digest: increment.digest });
		expect(await readCounter(client, create.createdId)).toBe(1n);
	});
});
