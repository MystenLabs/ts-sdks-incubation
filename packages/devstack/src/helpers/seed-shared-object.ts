// Submit a Move call that creates a shared object and capture the
// resulting object id from `objectChanges[]`. Used by Seed actions to
// bootstrap arbitrary shared state (arena's openLobby, future market
// init objects, etc).
//
// The `buildTx` extension hook lets callers pass any combination of pure
// / object / type arguments without baking a generic encoder into the
// helper.

import type { Signer } from '@mysten/sui/cryptography';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

import { objectTypeMatchesFilter } from './match-type.js';

interface SeedSharedObjectOptions {
	client: SuiJsonRpcClient;
	publisher: Signer;
	target: `${string}::${string}::${string}`;
	objectTypeFilter: string;
	buildTx?: (tx: Transaction, target: SeedSharedObjectOptions['target']) => void;
	gasBudget?: bigint;
}

interface SeedSharedObjectResult {
	objectId: string;
	objectType: string;
	digest: string;
}

export async function seedSharedObject(
	opts: SeedSharedObjectOptions,
): Promise<SeedSharedObjectResult> {
	const tx = new Transaction();
	if (opts.buildTx !== undefined) {
		opts.buildTx(tx, opts.target);
	} else {
		tx.moveCall({ target: opts.target });
	}
	if (opts.gasBudget !== undefined) tx.setGasBudget(opts.gasBudget);

	const result = await opts.client.signAndExecuteTransaction({
		signer: opts.publisher,
		transaction: tx,
		options: { showObjectChanges: true, showEffects: true },
	});

	if (result.effects?.status.status !== 'success') {
		throw new Error(
			`devstack seedSharedObject: ${opts.target} failed: ${result.effects?.status.error ?? 'unknown'}`,
		);
	}

	const created = (result.objectChanges ?? []).find(
		(c) =>
			c.type === 'created' &&
			'objectType' in c &&
			objectTypeMatchesFilter(c.objectType, opts.objectTypeFilter),
	);
	if (created === undefined || !('objectId' in created) || !('objectType' in created)) {
		throw new Error(
			`devstack seedSharedObject: no created object matched "${opts.objectTypeFilter}". ` +
				`objectChanges: ${JSON.stringify(result.objectChanges)}`,
		);
	}
	return { objectId: created.objectId, objectType: created.objectType, digest: result.digest };
}
