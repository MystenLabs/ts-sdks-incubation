// Seal plugin — SDK-backed Move publish + on-chain KeyServer register.

import { createHash } from 'node:crypto';

import { Effect, Schema, type Scope } from 'effect';

import {
	Transaction,
	type TransactionArgument,
	type TransactionObjectArgument,
} from '@mysten/sui/transactions';

import type { ChainProbe, ChainProbeSchema } from '../../contracts/chain-probe.ts';
import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import {
	artifactPublishError,
	type ArtifactPublishError,
	type ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import { contentHash, type ContentHash } from '../../substrate/brand.ts';
import {
	executeSuiTx,
	formatExecutedFailure,
	hashMoveSources,
	runMoveBuild,
	scrubLocksHost,
	withMoveBuildLock,
	type BuildOutput,
	type ExecutedReceipt,
	type MoveBuildError,
	type ClientWithCoreApi,
} from '../sui/index.ts';
import { fromHex } from '@mysten/sui/utils';

import type { AccountValue } from '../account/index.ts';
import { sealError, type SealError } from './errors.ts';

const KEY_TYPE_BONEH_FRANKLIN_BLS12381 = 0;

export type SealObjectProbeKey = { readonly kind: 'object'; readonly objectId: string };

export interface SealSuiSdk {
	readonly client: ClientWithCoreApi;
}

const sealProduceFailed = (op: 'publish' | 'register', err: SealError): ArtifactPublishError =>
	artifactPublishError('produce-failed', `seal.${op} ${err.phase}: ${err.message}`);

const moveBuildToSealError = (name: string, err: MoveBuildError): SealError =>
	sealError('publish', {
		name,
		message: `seal publish ${err.phase} failed for source '${err.sourcePath}': ${err.message}`,
		cause: err,
	});

const verifyObjectLenient = <Verified>(
	probe: ChainProbe<SealObjectProbeKey>,
	objectId: string,
	schema: ChainProbeSchema<Verified>,
): Effect.Effect<Verified | null, never> =>
	probe
		.get({ kind: 'object', objectId }, schema, 'lenient')
		.pipe(Effect.catch(() => Effect.succeed(null as Verified | null)));

// ---------------------------------------------------------------------------
// Move publish — `sealPackage` artifact
// ---------------------------------------------------------------------------

export const SEAL_PACKAGE_NAMESPACE = 'seal/package' as const;

export interface SealPackageCached {
	readonly packageId: string;
	readonly upgradeCapId?: string;
}

export const SealPackageVerifyShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.optional(Schema.Unknown),
});
export type SealPackageVerified = Schema.Schema.Type<typeof SealPackageVerifyShape>;

export interface SealPublishInputs {
	readonly name: string;
	readonly chainId: string;
	readonly movePackagePath: string;
	readonly signer: AccountValue;
	readonly sdk: SealSuiSdk;
	readonly runtime: ContainerRuntime;
	readonly buildImage?: ImageRef;
	readonly chainProbe: ChainProbe<SealObjectProbeKey>;
}

export const sealPackageInputsHash = (
	sourceHash: ContentHash,
	signerAddress: string,
): ContentHash => contentHash(`seal-package|source=${sourceHash}|signer=${signerAddress}`);

export interface SealPublishTransactionBuilder<TUpgradeCap = unknown> {
	readonly setSender: (address: string) => void;
	readonly publish: (input: {
		readonly modules: ReadonlyArray<ReadonlyArray<number>>;
		readonly dependencies: ReadonlyArray<string>;
	}) => TUpgradeCap;
	readonly transferObjects: (objects: ReadonlyArray<TUpgradeCap>, recipient: string) => void;
}

const publishTransactionBuilder = (
	tx: Transaction,
): SealPublishTransactionBuilder<TransactionObjectArgument> => ({
	setSender: (address) => tx.setSender(address),
	publish: (input) =>
		tx.publish({
			modules: input.modules.map((m) => [...m]),
			dependencies: [...input.dependencies],
		}),
	transferObjects: (objects, recipient) => tx.transferObjects([...objects], recipient),
});

export const buildSealPublishTransaction = <TUpgradeCap>(
	tx: SealPublishTransactionBuilder<TUpgradeCap>,
	buildOutput: BuildOutput,
	signerAddress: string,
): void => {
	tx.setSender(signerAddress);
	const upgradeCap = tx.publish({
		modules: buildOutput.modules.map((m) => Array.from(m)),
		dependencies: [...buildOutput.dependencies],
	});
	tx.transferObjects([upgradeCap], signerAddress);
};

export const pickPackageWriteObjectId = (receipt: ExecutedReceipt): string | null =>
	receipt.objectChanges.find((change) => change.outputState === 'PackageWrite')?.objectId ?? null;

export const pickUpgradeCapObjectId = (receipt: ExecutedReceipt): string | null =>
	receipt.objectChanges.find(
		(change) =>
			change.idOperation === 'Created' &&
			(change.objectType?.endsWith('::package::UpgradeCap') ?? false),
	)?.objectId ?? null;

export const projectSealPublishReceipt = (
	name: string,
	receipt: ExecutedReceipt,
): Effect.Effect<SealPackageCached, SealError> => {
	const packageId = pickPackageWriteObjectId(receipt);
	if (packageId === null) {
		return Effect.fail(
			sealError('publish', {
				name,
				message: `seal publish tx wrote no PackageWrite object ` + `(digest=${receipt.digest})`,
			}),
		);
	}
	const upgradeCapId = pickUpgradeCapObjectId(receipt);
	return Effect.succeed({
		packageId,
		...(upgradeCapId !== null ? { upgradeCapId } : {}),
	});
};

export const runSealPublishTransaction = (
	inputs: SealPublishInputs,
): Effect.Effect<SealPackageCached, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		// Scrub the shared Move git cache, then build — both under the
		// process-wide Move-build permit (`withMoveBuildLock`) so this build
		// can't race a concurrent package build's host scrub against a sibling
		// container's `git clone` into the same `~/.move/git` cache. The host
		// scrub strips stale pins so they can't leak into the build; the
		// package's own Move.lock is scrubbed inside the container on a
		// disposable copy, leaving the developer's checked-in source untouched.
		const buildOutput = yield* withMoveBuildLock(
			Effect.gen(function* () {
				yield* scrubLocksHost(inputs.movePackagePath, '~/.move').pipe(
					Effect.mapError((err) => moveBuildToSealError(inputs.name, err)),
				);

				return yield* runMoveBuild({
					sourcePath: inputs.movePackagePath,
					packageName: inputs.name,
					runtime: inputs.runtime,
					...(inputs.buildImage !== undefined ? { buildImage: inputs.buildImage } : {}),
				}).pipe(Effect.mapError((err) => moveBuildToSealError(inputs.name, err)));
			}),
		);

		const result = yield* executeSuiTx({
			client: inputs.sdk.client,
			signer: inputs.signer,
			build: async () => {
				const tx = new Transaction();
				buildSealPublishTransaction(
					publishTransactionBuilder(tx),
					buildOutput,
					inputs.signer.address,
				);
				return tx.build({ client: inputs.sdk.client });
			},
		}).pipe(
			Effect.mapError((cause) =>
				sealError('publish', {
					name: inputs.name,
					message:
						`seal publish tx failed for signer '${inputs.signer.name}' ` +
						`(address=${inputs.signer.address}) during ${cause.phase}: ${cause.message}`,
					cause,
				}),
			),
		);
		if (result.$kind === 'FailedTransaction') {
			return yield* Effect.fail(
				sealError('publish', {
					name: inputs.name,
					message:
						`seal publish tx executed but on-chain execution failed for signer ` +
						`'${inputs.signer.name}' (address=${inputs.signer.address}) ` +
						formatExecutedFailure(result.FailedTransaction),
				}),
			);
		}

		return yield* projectSealPublishReceipt(inputs.name, result.Transaction);
	});

export const publishSealPackage = (
	publisher: ArtifactPublisher,
	inputs: SealPublishInputs,
): Effect.Effect<{ readonly packageId: string }, ArtifactPublishError | SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const sourceHash = yield* hashMoveSources(inputs.movePackagePath).pipe(
			Effect.mapError((err) => moveBuildToSealError(inputs.name, err)),
		);
		const inputsHash = sealPackageInputsHash(sourceHash, inputs.signer.address);

		const cached: SealPackageCached = yield* publisher.publish<
			SealPackageCached,
			SealPackageVerified
		>({
			namespace: SEAL_PACKAGE_NAMESPACE,
			chain: inputs.chainId,
			contentHash: inputsHash,
			verify: (cached) =>
				verifyObjectLenient(inputs.chainProbe, cached.packageId, SealPackageVerifyShape),
			produce: runSealPublishTransaction(inputs).pipe(
				Effect.mapError((err) => sealProduceFailed('publish', err)),
			),
			register: () => Effect.void,
		});

		return { packageId: cached.packageId };
	});

// ---------------------------------------------------------------------------
// KeyServer register — `keyServer` artifact
// ---------------------------------------------------------------------------

export const SEAL_KEY_SERVER_NAMESPACE = 'seal/key-server-id' as const;

export interface SealKeyServerCached {
	readonly objectId: string;
}

export const SealKeyServerVerifyShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.optional(Schema.Unknown),
});
export type SealKeyServerVerified = Schema.Schema.Type<typeof SealKeyServerVerifyShape>;

export interface RegisterKeyServerTransactionInputs {
	readonly keyServerUrl: string;
	readonly sealPackageId: string;
	readonly publicKeyHex: string;
	readonly keyServerName: string;
}

export interface RegisterKeyServerInputs extends RegisterKeyServerTransactionInputs {
	readonly name: string;
	readonly chainId: string;
	readonly signer: AccountValue;
	readonly sdk: SealSuiSdk;
	readonly chainProbe: ChainProbe<SealObjectProbeKey>;
}

export const sealRegisterInputsHash = (
	inputs: RegisterKeyServerTransactionInputs,
	signerAddress: string,
): ContentHash =>
	// Keep the cache key path-safe and bounded. The raw material includes
	// a routed URL plus a long BLS public key; using it directly made the
	// best-effort cache write miss on normal restarts.
	contentHash(
		`seal-register-v2|${createHash('sha256')
			.update(
				JSON.stringify({
					packageId: inputs.sealPackageId,
					keyServerUrl: inputs.keyServerUrl,
					keyServerName: inputs.keyServerName,
					publicKeyHex: inputs.publicKeyHex,
					signerAddress,
				}),
			)
			.digest('hex')}`,
	);

export interface SealRegisterTransactionBuilder<TArgument = unknown> {
	readonly pure: {
		readonly string: (value: string) => TArgument;
		readonly u8: (value: number) => TArgument;
		readonly vector: (type: 'u8', value: ReadonlyArray<number>) => TArgument;
	};
	readonly setSender: (address: string) => void;
	readonly moveCall: (input: {
		readonly target: string;
		readonly arguments: ReadonlyArray<TArgument>;
	}) => unknown;
}

export type SealRegisterSdk = SealSuiSdk;

const registerTransactionBuilder = (
	tx: Transaction,
): SealRegisterTransactionBuilder<TransactionArgument> => ({
	pure: {
		string: (value) => tx.pure.string(value),
		u8: (value) => tx.pure.u8(value),
		vector: (type, value) => tx.pure.vector(type, [...value]),
	},
	setSender: (address) => tx.setSender(address),
	moveCall: (input) =>
		tx.moveCall({
			target: input.target,
			arguments: [...input.arguments],
		}),
});

export const buildRegisterKeyServerMoveCall = <TArgument>(
	tx: SealRegisterTransactionBuilder<TArgument>,
	inputs: RegisterKeyServerTransactionInputs,
	signerAddress: string,
): void => {
	const pkBytes = fromHex(inputs.publicKeyHex);
	tx.setSender(signerAddress);
	tx.moveCall({
		target: `${inputs.sealPackageId}::key_server::create_and_transfer_v2_independent_server`,
		arguments: [
			tx.pure.string(inputs.keyServerName),
			tx.pure.string(inputs.keyServerUrl),
			tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
			tx.pure.vector('u8', Array.from(pkBytes)),
		],
	});
};

export const pickCreatedKeyServerObjectId = (receipt: ExecutedReceipt): string | null =>
	receipt.objectChanges.find(
		(change) =>
			change.idOperation === 'Created' &&
			(change.objectType?.endsWith('::key_server::KeyServer') ?? false),
	)?.objectId ?? null;

export const projectRegisterKeyServerReceipt = (
	name: string,
	receipt: ExecutedReceipt,
): Effect.Effect<SealKeyServerCached, SealError> => {
	const objectId = pickCreatedKeyServerObjectId(receipt);
	if (objectId === null) {
		return Effect.fail(
			sealError('register', {
				name,
				message:
					`seal register tx created no ::key_server::KeyServer object ` +
					`(digest=${receipt.digest})`,
			}),
		);
	}
	return Effect.succeed({ objectId });
};

export const runRegisterKeyServerTransaction = (
	sdk: SealRegisterSdk,
	signer: AccountValue,
	inputs: RegisterKeyServerInputs,
): Effect.Effect<SealKeyServerCached, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const result = yield* executeSuiTx({
			client: sdk.client,
			signer,
			build: async () => {
				const tx = new Transaction();
				buildRegisterKeyServerMoveCall(registerTransactionBuilder(tx), inputs, signer.address);
				return tx.build({ client: sdk.client });
			},
		}).pipe(
			Effect.mapError((cause) =>
				sealError('register', {
					name: inputs.name,
					message:
						`seal register tx failed for signer '${signer.name}' ` +
						`(address=${signer.address}) during ${cause.phase}: ${cause.message}`,
					cause,
				}),
			),
		);
		if (result.$kind === 'FailedTransaction') {
			return yield* Effect.fail(
				sealError('register', {
					name: inputs.name,
					message:
						`seal register tx executed but on-chain execution failed for signer ` +
						`'${signer.name}' (address=${signer.address}) ` +
						formatExecutedFailure(result.FailedTransaction),
				}),
			);
		}

		return yield* projectRegisterKeyServerReceipt(inputs.name, result.Transaction);
	});

export const registerKeyServer = (
	publisher: ArtifactPublisher,
	inputs: RegisterKeyServerInputs,
): Effect.Effect<{ readonly objectId: string }, ArtifactPublishError | SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const inputsHash = sealRegisterInputsHash(inputs, inputs.signer.address);
		const cached: SealKeyServerCached = yield* publisher.publish<
			SealKeyServerCached,
			SealKeyServerVerified
		>({
			namespace: SEAL_KEY_SERVER_NAMESPACE,
			chain: inputs.chainId,
			contentHash: inputsHash,
			verify: (cached) =>
				verifyObjectLenient(inputs.chainProbe, cached.objectId, SealKeyServerVerifyShape),
			produce: runRegisterKeyServerTransaction(inputs.sdk, inputs.signer, inputs).pipe(
				Effect.mapError((err) => sealProduceFailed('register', err)),
			),
			register: () => Effect.void,
		});

		return { objectId: cached.objectId };
	});
