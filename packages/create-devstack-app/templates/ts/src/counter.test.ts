// Live-stack spec: create → increment → read a shared Counter against the
// stack `pnpm dev` keeps running. The devstack test setup loads the stack's
// manifest once per file; the test funds a throwaway keypair from the local
// faucet and submits real transactions.

import {
	getStackContext,
	useDevstackTestSetup,
	type StackContext,
} from '@mysten-incubation/devstack/vitest';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DEV_HINT =
	'start the stack with `pnpm dev` and keep it running (or `pnpm apply` for a one-shot boot), then re-run `pnpm test`';

function liveStack(): StackContext {
	const stack = getStackContext();
	if (stack === undefined) throw new Error(`no devstack manifest loaded — ${DEV_HINT}`);
	return stack;
}

/** A stopped stack still leaves its last manifest behind, so manifest
 *  presence alone doesn't prove liveness — probe the RPC endpoint too.
 *  The devstack router outlives individual stacks and answers routed
 *  hostnames even when this stack is down, so a dead backend surfaces as
 *  an HTTP error status (404/5xx), not a network failure. (A live gRPC
 *  rpc answers a bare GET with 405.) */
async function probeRpc(): Promise<void> {
	const rpcUrl = liveStack().endpoint('rpc');
	if (rpcUrl === undefined) {
		throw new Error(`stack manifest exposes no 'rpc' endpoint — ${DEV_HINT}`);
	}
	const probe = await fetch(rpcUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => {
		throw new Error(`devstack manifest found, but ${rpcUrl} is not responding — ${DEV_HINT}`);
	});
	if (probe.status === 404 || probe.status >= 502) {
		throw new Error(
			`devstack manifest found, but the stack behind ${rpcUrl} is not running (HTTP ${probe.status}) — ${DEV_HINT}`,
		);
	}
}

// `requireDevstack: true` makes the setup throw when the stack has never
// been booted (no manifest on disk); the wrapper turns that and a dead RPC
// into a `pnpm dev` pointer instead of a raw fetch error. The suite
// deliberately shares the `pnpm dev` stack (everything it does is
// additive), so the "set DEVSTACK_STACK" advisory is silenced.
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
				await probeRpc();
			}),
	},
	{ requireDevstack: true, silent: true },
);

/** Sign with `signer`, execute, and wait for finality. */
async function signAndExecute(client: ClientWithCoreApi, signer: Ed25519Keypair, tx: Transaction) {
	tx.setSender(signer.toSuiAddress());
	const bytes = await tx.build({ client });
	const { signature } = await signer.signTransaction(bytes);
	const result = await client.core.executeTransaction({
		transaction: bytes,
		signatures: [signature],
		include: { effects: true },
	});
	if (result.$kind !== 'Transaction') {
		const error = JSON.stringify(result.FailedTransaction.status.error);
		throw new Error(`transaction failed: ${error}`);
	}
	await client.core.waitForTransaction({ digest: result.Transaction.digest });
	return result.Transaction;
}

describe('counter (live devstack)', () => {
	it('creates, increments, and reads back a shared Counter', async () => {
		// Imported lazily so a never-booted checkout fails with the beforeAll's
		// `pnpm dev` hint, not an unresolved import for src/generated/.
		const { createCounterTx, incrementTx, readCounter } = await import('./counter.ts');
		const { config } = await import('./generated/config.ts');

		const stack = liveStack();
		const rpcUrl = stack.endpoint('rpc');
		const faucetUrl = stack.endpoint('faucet');
		if (rpcUrl === undefined || faucetUrl === undefined) {
			throw new Error(`stack manifest is missing the sui rpc/faucet endpoints — ${DEV_HINT}`);
		}

		const client: ClientWithCoreApi = new SuiGrpcClient({
			network: 'localnet',
			baseUrl: rpcUrl,
			// Resolves the bindings' default `@local/counter` package name to
			// the deployed id at tx-build time.
			mvr: { overrides: { packages: config.mvrOverrides } },
		});

		// Throwaway on-chain actor, funded by the stack's faucet.
		const signer = Ed25519Keypair.generate();
		const funded = await requestSuiFromFaucetV2({
			host: faucetUrl,
			recipient: signer.toSuiAddress(),
		});
		if (funded.status !== 'Success') {
			throw new Error(`faucet request failed: ${JSON.stringify(funded.status)}`);
		}
		await Promise.all(
			(funded.coins_sent ?? []).map(({ transferTxDigest }) =>
				client.core.waitForTransaction({ digest: transferTxDigest }),
			),
		);

		const created = await signAndExecute(client, signer, createCounterTx());
		const counterId = created.effects.changedObjects.find(
			(change) => change.idOperation === 'Created',
		)?.objectId;
		if (counterId === undefined) throw new Error('create_and_share created no object');

		expect(await readCounter(client, counterId)).toBe(0n);

		await signAndExecute(client, signer, incrementTx(counterId));
		expect(await readCounter(client, counterId)).toBe(1n);
	});
});
