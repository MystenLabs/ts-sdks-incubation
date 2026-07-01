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

import { extractExecuteDigest } from '../../../src/plugins/sui/exec/index.ts';
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
	readonly publisherUrl: string | null;
	readonly uploadRelayUrl: string | null;
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

const SUI_RESOLVED_KEY = /^sui(?:#\d+|[:/])/;

export const suiOf = (ctx: BootScopeContext): SuiResolvedLite | undefined =>
	findResolved(ctx, SUI_RESOLVED_KEY) as SuiResolvedLite | undefined;
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
 *  it is only in the probe list for deepbook-enabled runs.
 *
 *  Fails LOUDLY (mirroring {@link suiClientOf}) when the deepbook value is
 *  absent: deepbook is a `task`-role plugin, so a failed publish is TOLERATED
 *  by the boot (`acquire-node.ts` marks it failed + reports the error, but does
 *  not abort) — it just never lands in `resolvedValues`. Without this guard the
 *  probe NPE's with an opaque `Cannot read properties of undefined (reading
 *  'packageId')`; this names the real cause and dumps the resolved keys so the
 *  absence is unambiguous. Re-run with the boot logger enabled (drop the
 *  `Logger.layer([])` in `boot-config-impl.ts`) to surface the publish cause. */
export const deepbookOf = (ctx: BootScopeContext): DeepbookResolvedLite => {
	const deepbook = findResolved(ctx, /^deepbook[:/]/) as DeepbookResolvedLite | undefined;
	if (deepbook === undefined) {
		const keys = [...ctx.resolvedValues.keys()].join(', ');
		throw new Error(
			`deepbookOf: no resolved deepbook value — its task plugin failed to publish ` +
				`(the boot tolerates task failures, so deepbook is absent rather than fatal). ` +
				`Boot resolved: [${keys}]`,
		);
	}
	return deepbook;
};

/** The `SuiGrpcClient` (ClientWithCoreApi) the harness built — reuse it for
 *  reads, `tx.build`, and as the WalrusClient/SealClient backing client. */
export const suiClientOf = (ctx: BootScopeContext): ClientWithCoreApi => {
	const sui = suiOf(ctx);
	if (sui === undefined) {
		const keys = [...ctx.resolvedValues.keys()].join(', ');
		throw new Error(`suiClientOf: no resolved Sui value; boot resolved: [${keys}]`);
	}
	return sui.sdk.client;
};

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
		storageNodeUrlScheme: 'https',
	});

const nestedString = (
	value: unknown,
	paths: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined => {
	for (const path of paths) {
		let cursor = value;
		for (const segment of path) {
			cursor =
				typeof cursor === 'object' && cursor !== null
					? (cursor as Record<string, unknown>)[segment]
					: undefined;
		}
		if (typeof cursor === 'string' && cursor.length > 0) return cursor;
	}
	return undefined;
};

const extractBlobId = (response: unknown): string => {
	const blobId = nestedString(response, [
		['newlyCreated', 'blobObject', 'blob_id'],
		['newlyCreated', 'blobObject', 'blobId'],
		['newlyCreated', 'blob_id'],
		['newlyCreated', 'blobId'],
		['alreadyCertified', 'blob_id'],
		['alreadyCertified', 'blobId'],
		['blob_id'],
		['blobId'],
	]);
	if (blobId !== undefined) return blobId;
	throw new Error(
		`snapshot-matrix: Walrus publisher response did not contain a blob id: ${JSON.stringify(
			response,
		).slice(0, 1_000)}`,
	);
};

const requireEndpoint = (
	walrus: WalrusResolvedLite,
	key: 'aggregatorUrl' | 'publisherUrl',
): string => {
	const value = walrus[key];
	if (value === null) {
		throw new Error(`snapshot-matrix: local Walrus ${key} is disabled`);
	}
	return value;
};

const putBlobViaPublisher = async (
	walrus: WalrusResolvedLite,
	args: {
		readonly blob: Uint8Array;
		readonly signer: Ed25519Keypair;
		readonly epochs: number;
		readonly deletable: boolean;
	},
): Promise<{ readonly blobId: string }> => {
	const url = new URL('/v1/blobs', requireEndpoint(walrus, 'publisherUrl'));
	url.searchParams.set('epochs', String(args.epochs));
	if (args.deletable) url.searchParams.set('deletable', 'true');
	url.searchParams.set('send_object_to', args.signer.toSuiAddress());

	const response = await fetch(url, {
		method: 'PUT',
		body: new Uint8Array(args.blob).buffer as ArrayBuffer,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`snapshot-matrix: Walrus publisher PUT failed HTTP ${response.status}: ${text.slice(0, 1_000)}`,
		);
	}
	return { blobId: extractBlobId(JSON.parse(text) as unknown) };
};

export const readWalrusBlob = async (
	suiClient: ClientWithCoreApi,
	walrus: WalrusResolvedLite,
	blobId: string,
): Promise<Uint8Array> => {
	if (walrus.mode !== 'local') {
		return await makeWalrusClient(suiClient, walrus).readBlob({ blobId });
	}
	const response = await fetch(
		new URL(`/v1/blobs/${blobId}`, requireEndpoint(walrus, 'aggregatorUrl')),
	);
	if (!response.ok) {
		throw new Error(
			`snapshot-matrix: Walrus aggregator GET failed HTTP ${response.status}: ${(
				await response.text()
			).slice(0, 1_000)}`,
		);
	}
	return new Uint8Array(await response.arrayBuffer());
};

/** writeBlob, retried. For local mode this goes through the real Rust
 *  publisher endpoint instead of constructing a direct SDK client on the host;
 *  the publisher then fans slivers out to every storage node using the
 *  committee Docker aliases. Immediately after a snapshot pauses+commits+
 *  unpauses those containers (the matrix writes S2 right after
 *  `snapshot.capture`), the first write can fail while the nodes re-settle.
 *  Retry across that window. Returns the content-addressed blob id. */
export const writeWalrusBlobWithRetry = async (
	suiClient: ClientWithCoreApi,
	walrus: WalrusResolvedLite,
	args: {
		readonly blob: Uint8Array;
		readonly signer: Ed25519Keypair;
		readonly epochs: number;
		readonly deletable: boolean;
	},
): Promise<{ readonly blobId: string }> => {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			if (walrus.mode === 'local') return await putBlobViaPublisher(walrus, args);
			const written = await makeWalrusClient(suiClient, walrus).writeBlob(args);
			return { blobId: written.blobId };
		} catch (err) {
			lastErr = err;
			if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
	}
	throw lastErr;
};

/** One created/mutated object from a transaction's effects: its id plus
 *  (when `objectTypes` was requested) its fully-qualified Move type. Lets a
 *  probe resolve a SHARED object's id — which `listOwnedObjects` can't see —
 *  straight from the creating tx (e.g. the vault `File`). */
export interface ExecutedChange {
	readonly objectId: string;
	readonly objectType: string | undefined;
}

/** First changed object whose Move type equals `type` (e.g.
 *  `${vaultPackageId}::vault::File`). Used to recover a shared object's id
 *  from the tx that created it. */
export const createdObjectOfType = (
	changes: ReadonlyArray<ExecutedChange>,
	type: string,
): string | undefined => changes.find((c) => c.objectType === type)?.objectId;

/** Sign a freshly-built transaction with the fresh keypair and execute it
 *  through the harness's grpc client, waiting for finality. Mirrors the
 *  account plugin's execute path (executeTransaction + waitForTransaction)
 *  but with a real Signer instead of the lease-brokered closures. Returns the
 *  flat `changes` array (id + type per changed object), projected from the
 *  same `effects.changedObjects` / `objectTypes` envelope the substrate's
 *  `executeSuiTx` reads — so callers can find a created shared object by type. */
export const signAndExecuteAs = async (
	client: ClientWithCoreApi,
	keypair: Ed25519Keypair,
	build: (tx: Transaction) => void,
): Promise<{
	readonly digest: string | undefined;
	readonly raw: unknown;
	readonly changes: ReadonlyArray<ExecutedChange>;
}> => {
	const tx = new Transaction();
	tx.setSender(keypair.toSuiAddress());
	build(tx);
	const bytes = await tx.build({ client });
	const { signature } = await keypair.signTransaction(bytes);
	const raw = await client.core.executeTransaction({
		transaction: bytes,
		signatures: [signature],
		include: { effects: true, objectTypes: true },
	});
	const digest = extractExecuteDigest(raw);
	if (digest !== undefined) {
		await client.core.waitForTransaction({ digest });
	}
	const env = raw as {
		readonly Transaction?: {
			readonly effects?: {
				readonly changedObjects?: ReadonlyArray<{ readonly objectId?: string }>;
			};
			readonly objectTypes?: Readonly<Record<string, string>>;
		};
	};
	const types = env.Transaction?.objectTypes ?? {};
	const changes: ExecutedChange[] = [];
	for (const ch of env.Transaction?.effects?.changedObjects ?? []) {
		if (typeof ch.objectId === 'string') {
			changes.push({ objectId: ch.objectId, objectType: types[ch.objectId] });
		}
	}
	return { digest, raw, changes };
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
		// Guard the resolved-value lookups: a restore that fails to bring a
		// subsystem back up surfaces here as an undefined resolved value
		// (`suiOf(ctx)` → reading `.sdk` of undefined). Dump the keys the boot
		// DID resolve so the failure names what's missing instead of a cryptic
		// deref crash four frames deep.
		if (suiOf(ctx) === undefined) {
			const keys = [...ctx.resolvedValues.keys()].join(', ');
			return yield* Effect.die(`makeEnv: no resolved Sui value; boot resolved: [${keys}]`);
		}
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
		const deepbook = findResolved(ctx, /^deepbook[:/]/) as
			| { readonly packageId?: string }
			| undefined;
		console.log(
			`[snapshot-matrix] ids actor=${address} walCoinType=${env.walrus.walCoinType} ` +
				`sealObjectId=${env.seal.objectId} vaultPkg=${env.vaultPackageId} ` +
				`deepbookPkg=${deepbook?.packageId} funded=${opts.fund}`,
		);
		return env;
	});
