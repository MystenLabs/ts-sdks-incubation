// Headless probe environment for the snapshot/restore matrix.
//
// Constructs Node-side SDK access against the host-reachable routed
// endpoints, plus a fresh funded Ed25519 keypair that acts as the test's
// on-chain actor.
//
// Why a fresh keypair: the account plugin hides its keypairs behind Effect
// closures (`signAndExecute` routes through an address-lease broker), so it
// cannot be handed to the @mysten SDKs which want a real `Signer`. Instead
// we mint a fresh Ed25519Keypair (a real Signer) and bankroll it SUI+WAL
// from the compose-time-funded `bank` account via `bank.signAndExecute`.
//
// Sui client: we reuse the `SuiGrpcClient` the harness already built into
// the resolved value (`sui.sdk.client`, a ClientWithCoreApi). The JSON-RPC
// `SuiClient` is gone in @mysten/sui 2.x — everything goes through
// `client.core.*` and `tx.build({ client })`.

import { Effect } from 'effect';

import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { WalrusClient } from '@mysten/walrus';

import { extractExecuteDigest } from '../../../src/substrate/runtime/sui-execute/index.ts';
import type { BootScopeContext } from '../boot-config-impl.ts';

const SUI_COIN_TYPE = '0x2::sui::SUI';

// --- structural views of the resolved values we read (mirror what
// private-content-boot.test.ts does to avoid coupling to internal types) ---

export interface WalrusResolvedLite {
	readonly mode: 'local' | 'known';
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly nodes: ReadonlyArray<{ readonly rpcUrl: string }>;
	readonly aggregatorUrl: string | null;
	readonly walCoinType: string | null;
}

export interface SealResolvedLite {
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<{ readonly objectId: string; readonly weight: number }>;
}

interface SuiResolvedLite {
	readonly sdk: { readonly client: ClientWithCoreApi };
}

interface AccountLite {
	readonly address: string;
	readonly signAndExecute: (tx: Uint8Array) => Effect.Effect<{ readonly $kind: string }, unknown>;
}

/** First resolved value whose key matches (exact string or regex). Probes
 *  look subsystems up by identity, not ordinal — ordinals shift when the
 *  stack composition changes (e.g. adding deepbook). */
export const findResolved = (ctx: BootScopeContext, matcher: RegExp | string): unknown => {
	for (const [key, value] of ctx.resolvedValues) {
		const hit = typeof matcher === 'string' ? key === matcher : matcher.test(key);
		if (hit) return value;
	}
	return undefined;
};

export const suiOf = (ctx: BootScopeContext): SuiResolvedLite =>
	findResolved(ctx, /^sui#\d+$/) as SuiResolvedLite;
export const walrusOf = (ctx: BootScopeContext): WalrusResolvedLite =>
	findResolved(ctx, 'walrus:walrus') as WalrusResolvedLite;
export const sealOf = (ctx: BootScopeContext): SealResolvedLite =>
	findResolved(ctx, 'seal:seal') as SealResolvedLite;
export const vaultPackageIdOf = (ctx: BootScopeContext): string =>
	(findResolved(ctx, /^package:vault#\d+$/) as { readonly packageId: string }).packageId;
export const bankOf = (ctx: BootScopeContext): AccountLite =>
	findResolved(ctx, /^account\/bank#\d+$/) as AccountLite;

interface DeepbookResolvedLite {
	readonly packageId: string;
	readonly registryId: string;
}
/** Present only when the stack is built with deepbook. The probe that reads
 *  it is only in the probe list for deepbook-enabled runs. */
export const deepbookOf = (ctx: BootScopeContext): DeepbookResolvedLite =>
	findResolved(ctx, /^deepbook[:/]/) as DeepbookResolvedLite;

/** The `SuiGrpcClient` (ClientWithCoreApi) the harness built — reuse it for
 *  reads, `tx.build`, and as the WalrusClient/SealClient backing client. */
export const suiClientOf = (ctx: BootScopeContext): ClientWithCoreApi => suiOf(ctx).sdk.client;

export const makeWalrusClient = (
	suiClient: ClientWithCoreApi,
	walrus: WalrusResolvedLite,
): WalrusClient =>
	new WalrusClient({
		suiClient,
		packageConfig: {
			systemObjectId: walrus.packageConfig.systemObjectId,
			stakingPoolId: walrus.packageConfig.stakingPoolId,
			...(walrus.packageConfig.exchangeIds
				? { exchangeIds: [...walrus.packageConfig.exchangeIds] }
				: {}),
		},
		storageNodeUrlScheme: walrus.mode === 'local' ? 'http' : 'https',
	});

/** Sign a freshly-built transaction with the fresh keypair and execute it
 *  through the harness's grpc client, waiting for finality. Mirrors the
 *  account plugin's execute path (executeTransaction + waitForTransaction)
 *  but with a real Signer instead of the lease-brokered closures. */
export const signAndExecuteAs = async (
	client: ClientWithCoreApi,
	keypair: Ed25519Keypair,
	build: (tx: Transaction) => void,
): Promise<{ readonly digest: string | undefined; readonly raw: unknown }> => {
	const tx = new Transaction();
	tx.setSender(keypair.toSuiAddress());
	build(tx);
	const bytes = await tx.build({ client });
	const { signature } = await keypair.signTransaction(bytes);
	const raw = await client.core.executeTransaction({
		transaction: bytes,
		signatures: [signature],
		include: { effects: true },
	});
	const digest = extractExecuteDigest(raw);
	if (digest !== undefined) {
		await client.core.waitForTransaction({ digest });
	}
	return { digest, raw };
};

/** Total SUI balance for an owner (best-effort parse of the nested gRPC
 *  balance shape; mirrors the account plugin's readSuiBalance). */
export const getSuiBalance = async (client: ClientWithCoreApi, owner: string): Promise<bigint> => {
	const response = await client.core.getBalance({ owner, coinType: SUI_COIN_TYPE });
	const outer =
		typeof response === 'object' && response !== null && 'balance' in response
			? (response as { readonly balance?: unknown }).balance
			: response;
	const value =
		typeof outer === 'object' && outer !== null && 'balance' in outer
			? (outer as { readonly balance?: unknown }).balance
			: outer;
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
	if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
	return 0n;
};

/** Transfer SUI + WAL from the compose-time-funded `bank` account to
 *  `address`. Runs inside the harness Effect so the account's address-lease
 *  broker is in context. Must happen BEFORE the snapshot so the fresh
 *  actor's funding survives a restore. */
export const fundAddress = (
	ctx: BootScopeContext,
	suiClient: ClientWithCoreApi,
	address: string,
	amounts: { readonly suiAmount: bigint; readonly walAmount: bigint },
): Effect.Effect<void, unknown> =>
	Effect.gen(function* () {
		const bank = bankOf(ctx);
		const walType = walrusOf(ctx).walCoinType;
		if (walType === null) {
			return yield* Effect.die('fundAddress: walrus exposes no walCoinType');
		}
		const txBytes = yield* Effect.promise(() => {
			const tx = new Transaction();
			tx.setSender(bank.address);
			const suiOut = tx.coin({ balance: amounts.suiAmount, type: SUI_COIN_TYPE, useGasCoin: true });
			const walOut = tx.coin({ balance: amounts.walAmount, type: walType });
			tx.transferObjects([suiOut, walOut], tx.pure.address(address));
			return tx.build({ client: suiClient });
		});
		const result = yield* bank.signAndExecute(txBytes);
		if (result.$kind !== 'Transaction') {
			return yield* Effect.die(`fundAddress: bank transfer failed: ${JSON.stringify(result)}`);
		}
	});

/** The environment every probe gets: the fresh signer, the grpc client, and
 *  the resolved ids of the stateful subsystems. */
export interface ProbeEnv {
	readonly ctx: BootScopeContext;
	readonly suiClient: ClientWithCoreApi;
	readonly keypair: Ed25519Keypair;
	readonly address: string;
	readonly walrus: WalrusResolvedLite;
	readonly seal: SealResolvedLite;
	readonly vaultPackageId: string;
}

/** Build the probe env. Funds the fresh actor on the FIRST boot only
 *  (`fund: true`) — that funding is captured by the snapshot, so on the
 *  post-restore boot (`fund: false`) the actor is still funded. */
export const makeEnv = (
	ctx: BootScopeContext,
	keypair: Ed25519Keypair,
	opts: { readonly fund: boolean },
): Effect.Effect<ProbeEnv, unknown> =>
	Effect.gen(function* () {
		const suiClient = suiClientOf(ctx);
		const address = keypair.toSuiAddress();
		if (opts.fund) {
			yield* fundAddress(ctx, suiClient, address, {
				suiAmount: 5_000_000_000n,
				walAmount: 2_000_000_000n,
			});
		}
		const env: ProbeEnv = {
			ctx,
			suiClient,
			keypair,
			address,
			walrus: walrusOf(ctx),
			seal: sealOf(ctx),
			vaultPackageId: vaultPackageIdOf(ctx),
		};
		console.log(
			`[snapshot-matrix] env actor=${address} walCoinType=${env.walrus.walCoinType} funded=${opts.fund}`,
		);
		return env;
	});
