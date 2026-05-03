// `runTransaction()` — ergonomic factory for app-level setup transactions.
//
// Wraps `seed()` with a tx-builder + signer-by-name + default
// marker-file idempotence. Use in `DevstackConfig.setup` to mint
// fixture coins, create shared objects, or otherwise mutate chain
// state at app bring-up:
//
//   setup: [
//     publishMove({ name: 'token-studio', path: './move/token-studio',
//                   capture: { admin: '::admin::AdminCap' } }),
//     runTransaction({
//       name: 'mint-initial-supply',
//       needs: ['token-studio'],
//       signer: 'alice',
//       build: (ctx, tx) => {
//         const pkg = ctx.registry.packages.require('token-studio');
//         tx.moveCall({
//           target: `${pkg.packageId}::token::mint`,
//           arguments: [tx.object(pkg.captured.admin), tx.pure.u64(1n)],
//         });
//       },
//     }),
//   ],
//
// Default `getStatus` is input-hash-keyed marker file. The marker lives at
// `<stackDir>/setup/<name>.done` and its CONTENT is the stableHash of
// the action's inputs (signer name + serialized build callback + scope +
// needs). The probe checks both presence AND hash match, so editing the
// build callback invalidates the marker and re-runs the transaction —
// closing the footgun where a stale marker would skip new code.
//
// Snapshot restore brings the marker back; `devstack stack drop` clears
// it. Override with explicit `getStatus` when the action's idempotence
// needs an on-chain probe (e.g. "treasury cap minted to alice").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Transaction } from '@mysten/sui/transactions';

import type {
	ActionRunContext,
	Provides,
	SeedAction,
	SetupActionScope,
} from '../core/types.js';
import { requireLocalnetCtx } from '../core/types.js';
import { openSuiRpcClient } from '../helpers/sui-client.js';
import { stackDir } from '../runtime/active-stack.js';
import { stableHash } from '../runtime/hash.js';
import { Transaction as TransactionImpl } from '@mysten/sui/transactions';
import { seed } from './seed.js';

export interface RunTransactionOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Account name that signs the tx. Resolved via `ctx.accounts.get`. */
	signer: string;
	/** Build the transaction. The returned tx (or the mutated input) is
	 * signed by `signer` and executed. Throws on non-success effects. */
	build: (ctx: ActionRunContext, tx: Transaction) => void | Promise<void>;
	/** Override the default marker-file idempotence with an on-chain
	 * probe. The setup synth-plugin's filter may already drop this action
	 * if scope doesn't match the active stack — getStatus runs only when
	 * scope passes. */
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	/** Setup-action scope. See `SetupActionScope`. Default: 'always'. */
	scope?: SetupActionScope;
}

export function runTransaction(opts: RunTransactionOptions): SeedAction<Record<string, unknown>> {
	// `Function.toString()` is the cheapest way to make build-callback
	// edits invalidate the marker. Closure-captured constants don't
	// appear in toString output — users who want those to invalidate
	// must reference them in the build body so the source captures the
	// reference (or pass them through `inputs` in a custom getStatus).
	const inputsHash = stableHash({
		signer: opts.signer,
		build: opts.build.toString(),
		scope: opts.scope ?? 'always',
		needs: opts.needs ?? [],
	});
	const action = seed({
		name: opts.name,
		needs: opts.needs,
		provides: opts.provides,
		inputs: { signer: opts.signer, inputsHash },
		runsAs: opts.signer,
		getStatus: opts.getStatus ?? defaultMarkerProbe(opts.name, inputsHash),
		run: async (ctx) => {
			requireLocalnetCtx(ctx);
			const client = openSuiRpcClient(ctx);
			const signer = ctx.accounts.get(opts.signer);
			const tx = new TransactionImpl();
			await opts.build(ctx, tx);
			const result = await client.signAndExecuteTransaction({
				signer,
				transaction: tx,
				options: { showEffects: true },
			});
			const status = result.effects?.status?.status;
			if (status !== 'success') {
				const err = result.effects?.status?.error ?? 'unknown';
				throw new Error(`runTransaction(${opts.name}): tx failed: ${err}`);
			}
			await client.waitForTransaction({ digest: result.digest });
			writeMarker(ctx, opts.name, inputsHash);
		},
	});
	if (opts.scope !== undefined) {
		action.scope = opts.scope;
	}
	return action;
}

function defaultMarkerProbe(
	name: string,
	expectedHash: string,
): (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }> {
	return async (ctx) => {
		if (ctx.network !== 'localnet') {
			return { ok: false, detail: 'live net — re-run' };
		}
		const path = markerPath(ctx, name);
		if (!existsSync(path)) return { ok: false, detail: 'marker absent' };
		const observed = readFileSync(path, 'utf8').trim();
		if (observed !== expectedHash) {
			return { ok: false, detail: 'inputs changed since marker' };
		}
		return { ok: true, detail: 'marker matches' };
	};
}

function markerPath(ctx: ActionRunContext, actionName: string): string {
	if (ctx.network !== 'localnet') {
		// Live nets share a dummy path — the live-net default getStatus
		// always returns ok:false anyway, so this is unreachable in
		// practice; keeping it defensive avoids a runtime undefined.
		return resolve(ctx.appDir, '.devstack', 'setup', `${actionName}.done`);
	}
	return resolve(stackDir(ctx.appDir, ctx.stack), 'setup', `${actionName}.done`);
}

function writeMarker(ctx: ActionRunContext, actionName: string, hash: string): void {
	const path = markerPath(ctx, actionName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${hash}\n`, 'utf8');
}
