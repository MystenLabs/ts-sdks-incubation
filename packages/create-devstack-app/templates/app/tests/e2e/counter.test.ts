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
// points at the ACTIVE (test) stack's output — fully typed, no
// stringly-typed endpoint lookups, always the test stack's values.

import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import { config } from '@generated/config.js';
import { createCounterTx, incrementTx, readCounter } from '../../src/counter.js';
import { executedTx } from '../../src/tx.js';

// `config.forNetwork(config.defaultNetwork)` returns the active (test) stack's
// connection entry with a non-undefined type and a loud throw — no
// `config.networks[...]` index-signature footgun (which would type `net` as
// possibly-undefined).
const net = config.forNetwork(config.defaultNetwork);

describe('counter (local devstack)', () => {
	it('creates a shared Counter and increments it', async () => {
		// `faucet` is optional AND nullable (`string | null | undefined`); `== null`
		// narrows BOTH `null` and `undefined` away so the faucet host is `string`.
		if (net.faucet == null) throw new Error('the test stack exposes no faucet endpoint');

		const client = new SuiGrpcClient({
			network: 'localnet',
			baseUrl: net.rpc,
			// Resolves the bindings' default `@local/counter` package name to the
			// deployed id at tx-build time (same wiring as `dapp-kit.ts`).
			mvr: { overrides: { packages: config.mvrOverrides } },
		});

		// Throwaway on-chain actor, funded by the stack's local faucet.
		const signer = new Ed25519Keypair();
		const grant = await requestSuiFromFaucetV2({
			host: net.faucet,
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
