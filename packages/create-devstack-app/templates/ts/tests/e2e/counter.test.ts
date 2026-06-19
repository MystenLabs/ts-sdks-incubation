// Integration spec: create → increment → read a shared Counter against a
// real local devstack.
//
// `pnpm test:e2e` boots a dedicated `test` stack, runs this, and
// tears it down — no manual `pnpm dev` needed, and it runs in parallel
// with a `pnpm dev` stack without contending (separate stack = separate
// chain/ports/codegen).
//
// Endpoints AND the deployed package id come from the generated `config`,
// imported through the `@generated` alias which the devstack Vite plugin
// points at the ACTIVE (test) stack's output. So the values are always
// the test stack's — fully typed, no stringly-typed endpoint lookups.

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import { config } from '@generated/config.ts';
import { createCounterTx, incrementTx, readCounter } from '../../src/counter.ts';
import { executedTx } from '../../src/tx.ts';

// `config.forNetwork(config.defaultNetwork)` returns the active (test) stack's
// connection entry with a non-undefined type, throwing if the network isn't in
// the deployment.
const net = config.forNetwork(config.defaultNetwork);

/** Sign with `signer`, execute, wait for finality, and return the
 *  digest + created object id (via the unit-tested `executedTx`). */
async function signAndExecute(client: ClientWithCoreApi, signer: Ed25519Keypair, tx: Transaction) {
	tx.setSender(signer.toSuiAddress());
	const bytes = await tx.build({ client });
	const { signature } = await signer.signTransaction(bytes);
	const result = await client.core.executeTransaction({
		transaction: bytes,
		signatures: [signature],
		include: { effects: true },
	});
	const executed = executedTx(result);
	await client.core.waitForTransaction({ digest: executed.digest });
	return executed;
}

describe('counter (local devstack)', () => {
	it('creates, increments, and reads back a shared Counter', async () => {
		// `faucet` is optional AND nullable (`string | null | undefined`); `== null`
		// narrows BOTH `null` and `undefined` away so the faucet host is `string`.
		if (net.faucet == null) throw new Error('the test stack exposes no faucet endpoint');

		const client: ClientWithCoreApi = new SuiGrpcClient({
			network: 'localnet',
			baseUrl: net.rpc,
			// Resolves the bindings' default `@local/counter` package name to
			// the deployed id at tx-build time.
			mvr: { overrides: config.mvrOverrides },
		});

		// Throwaway on-chain actor, funded by the stack's faucet.
		const signer = Ed25519Keypair.generate();
		const funded = await requestSuiFromFaucetV2({
			host: net.faucet,
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
		if (created.createdId === undefined) throw new Error('create_and_share created no object');

		expect(await readCounter(client, created.createdId)).toBe(0n);

		await signAndExecute(client, signer, incrementTx(created.createdId));
		expect(await readCounter(client, created.createdId)).toBe(1n);
	});
});
