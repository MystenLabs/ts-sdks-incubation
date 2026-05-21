import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Stream } from 'effect';

import type { ChainProbe } from '../../../src/contracts/chain-probe.ts';
import type {
	ContainerRuntime,
	ExecResult,
	OneShotSpec,
} from '../../../src/contracts/container-runtime.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';
import {
	buildSealPublishTransaction,
	buildRegisterKeyServerMoveCall,
	parseSealPublishOutput,
	parseRegisterKeyServerOutput,
	pickPackageWriteObjectId,
	pickUpgradeCapObjectId,
	pickCreatedKeyServerObjectId,
	projectSealPublishReceipt,
	projectRegisterKeyServerReceipt,
	runSealPublishTransaction,
	sealPackageInputsHash,
	sealRegisterInputsHash,
	type RegisterKeyServerTransactionInputs,
	type SealObjectProbeKey,
	type SealPublishTransactionBuilder,
	type SealRegisterTransactionBuilder,
} from '../../../src/plugins/seal/deploy.ts';
import { chainId, contentHash } from '../../../src/substrate/brand.ts';

const registerInputs: RegisterKeyServerTransactionInputs = {
	keyServerUrl: 'http://seal.seal.app.localhost',
	sealPackageId: '0x1234',
	publicKeyHex: '0x0a0b0c',
	keyServerName: 'devstack-local',
};

class FakePublishTx implements SealPublishTransactionBuilder<string> {
	sender: string | null = null;
	publishInput: {
		readonly modules: ReadonlyArray<ReadonlyArray<number>>;
		readonly dependencies: ReadonlyArray<string>;
	} | null = null;
	transfers: Array<{ readonly objects: ReadonlyArray<string>; readonly recipient: string }> = [];

	setSender(address: string): void {
		this.sender = address;
	}

	publish(input: {
		readonly modules: ReadonlyArray<ReadonlyArray<number>>;
		readonly dependencies: ReadonlyArray<string>;
	}): string {
		this.publishInput = input;
		return 'upgrade-cap-arg';
	}

	transferObjects(objects: ReadonlyArray<string>, recipient: string): void {
		this.transfers.push({ objects, recipient });
	}
}

class FakeRegisterTx implements SealRegisterTransactionBuilder {
	readonly arguments: Array<unknown> = [];
	readonly pure = {
		string: (value: string) => ({ kind: 'string', value }),
		u8: (value: number) => ({ kind: 'u8', value }),
		vector: (type: 'u8', value: ReadonlyArray<number>) => ({
			kind: 'vector',
			type,
			value,
		}),
	};
	sender: string | null = null;
	target: string | null = null;

	setSender(address: string): void {
		this.sender = address;
	}

	moveCall(input: { readonly target: string; readonly arguments: ReadonlyArray<unknown> }): void {
		this.target = input.target;
		this.arguments.push(...input.arguments);
	}
}

const unusedRuntimeMethod = () => Effect.die('not used');

const oneShotRuntime = (runOneShot: ContainerRuntime['runOneShot']): ContainerRuntime => ({
	ensureImage: unusedRuntimeMethod,
	ensureNetwork: unusedRuntimeMethod,
	ensureContainer: unusedRuntimeMethod,
	exec: unusedRuntimeMethod,
	runOneShot,
	inspectByLabels: unusedRuntimeMethod,
	followLogs: () => Stream.empty,
	pauseAndCommit: unusedRuntimeMethod,
	saveImage: () => Stream.empty,
	loadImage: unusedRuntimeMethod,
	tagImage: unusedRuntimeMethod,
	unpause: unusedRuntimeMethod,
	stop: unusedRuntimeMethod,
	sweepOrphans: unusedRuntimeMethod,
	removeManagedContainers: unusedRuntimeMethod,
	removeManagedImages: unusedRuntimeMethod,
	removeManagedNetworks: unusedRuntimeMethod,
	removeManagedVolumes: unusedRuntimeMethod,
});

const signerNotReached: AccountValue = {
	name: 'publisher',
	address: '0xabc',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	signAndExecute: () => Effect.die('not used'),
	withTransactionSigner: () => Effect.die('not used'),
	signTransaction: () => Effect.die('not used'),
	signPersonalMessage: () => Effect.die('not used'),
};

const chainProbeNotReached: ChainProbe<SealObjectProbeKey> = {
	get: () => Effect.die('not used'),
};

describe('seal deploy publish helpers', () => {
	it('parses legacy publish stdout for historical stub coverage', () => {
		expect(parseSealPublishOutput('package_id: 0xabc123\n')).toEqual({
			packageId: '0xabc123',
		});
	});

	it('builds the SDK publish tx with sender, publish modules, and UpgradeCap transfer', () => {
		const tx = new FakePublishTx();

		buildSealPublishTransaction(
			tx,
			{
				modules: [new Uint8Array([1, 2]), new Uint8Array([3])],
				dependencies: ['0x1', '0x2'],
			},
			'0xsigner',
		);

		expect(tx.sender).toBe('0xsigner');
		expect(tx.publishInput).toEqual({
			modules: [[1, 2], [3]],
			dependencies: ['0x1', '0x2'],
		});
		expect(tx.transfers).toEqual([{ objects: ['upgrade-cap-arg'], recipient: '0xsigner' }]);
	});

	it('projects the package id and UpgradeCap from SDK execute effects', async () => {
		expect(
			pickPackageWriteObjectId({
				digest: '0xdigest',
				objectChanges: [
					{ objectId: '0xpkg', outputState: 'PackageWrite' },
					{
						objectId: '0xcap',
						idOperation: 'Created',
						objectType: '0x2::package::UpgradeCap',
					},
				],
			}),
		).toBe('0xpkg');
		expect(
			pickUpgradeCapObjectId({
				digest: '0xdigest',
				objectChanges: [
					{ objectId: '0xpkg', outputState: 'PackageWrite' },
					{
						objectId: '0xcap',
						idOperation: 'Created',
						objectType: '0x2::package::UpgradeCap',
					},
				],
			}),
		).toBe('0xcap');

		await expect(
			Effect.runPromise(
				projectSealPublishReceipt('seal', {
					digest: '0xdigest',
					objectChanges: [
						{ objectId: '0xpkg', outputState: 'PackageWrite' },
						{
							objectId: '0xcap',
							idOperation: 'Created',
							objectType: '0x2::package::UpgradeCap',
						},
					],
				}),
			),
		).resolves.toEqual({ packageId: '0xpkg', upgradeCapId: '0xcap' });
	});

	it('fails with publish context when SDK effects omit the PackageWrite object', async () => {
		const exit = await Effect.runPromiseExit(
			projectSealPublishReceipt('seal', {
				digest: '0xdigest',
				objectChanges: [],
			}),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('SealError');
			expect(err.value.phase).toBe('publish');
			expect(err.value.message).toContain('wrote no PackageWrite object');
			expect(err.value.message).toContain('0xdigest');
		}
	});

	it('splits publish and register cache hashes by their real SDK inputs', () => {
		expect(sealPackageInputsHash(contentHash('source-a'), '0x1')).not.toBe(
			sealPackageInputsHash(contentHash('source-a'), '0x2'),
		);
		expect(sealRegisterInputsHash(registerInputs, '0x1')).not.toBe(
			sealRegisterInputsHash({ ...registerInputs, publicKeyHex: '0x0a0b0d' }, '0x1'),
		);
		expect(sealRegisterInputsHash(registerInputs, '0x1')).not.toBe(
			sealPackageInputsHash(contentHash('source-a'), '0x1'),
		);
	});

	it.effect('lets the container build scrub cached Seal source locks the host cannot write', () =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seal-deploy-')));
			const previousHome = process.env.HOME;
			const packageLock = join(
				root,
				'home',
				'.cache',
				'devstack-rewrite',
				'seal-src',
				'seal-v0.6.6',
				'move',
				'seal',
				'Move.lock',
			);
			try {
				const home = join(root, 'home');
				const sourcePath = join(
					home,
					'.cache',
					'devstack-rewrite',
					'seal-src',
					'seal-v0.6.6',
					'move',
					'seal',
				);
				process.env.HOME = home;
				yield* Effect.promise(() => mkdir(join(sourcePath, 'sources'), { recursive: true }));
				yield* Effect.promise(() =>
					writeFile(join(sourcePath, 'Move.toml'), '[package]\nname = "seal"\n'),
				);
				yield* Effect.promise(() =>
					writeFile(join(sourcePath, 'sources', 'seal.move'), 'module seal::seal {}\n'),
				);
				yield* Effect.promise(() =>
					writeFile(
						packageLock,
						'[move]\nversion = 3\n[pinned.testnet.dep]\npublished-at = "0x1"\n',
					),
				);
				yield* Effect.promise(() => chmod(packageLock, 0o444));

				const capturedSpecs: OneShotSpec[] = [];
				const runtime = oneShotRuntime((spec) =>
					Effect.sync((): ExecResult => {
						capturedSpecs.push(spec);
						return { exitCode: 99, stdout: '', stderr: 'forced build failure' };
					}),
				);

				const exit = yield* Effect.exit(
					runSealPublishTransaction({
						name: 'seal',
						chain: chainId('localnet'),
						movePackagePath: sourcePath,
						signer: signerNotReached,
						sdk: { client: {} },
						runtime,
						buildImage: { digest: 'sha256:sui' },
						chainProbe: chainProbeNotReached,
					}).pipe(Effect.scoped),
				);

				expect(capturedSpecs).toHaveLength(1);
				const error = Exit.findErrorOption(exit);
				expect(Option.isSome(error)).toBe(true);
				if (Option.isSome(error)) {
					expect(error.value._tag).toBe('SealError');
					expect(error.value.phase).toBe('publish');
					expect(error.value.message).toContain('docker run --rm sui move build exited 99');
					expect(error.value.message).not.toContain('scrub host locks failed');
				}
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
				yield* Effect.promise(() => chmod(packageLock, 0o644).catch(() => {}));
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}
		}),
	);
});

describe('seal deploy register helpers', () => {
	it('parses legacy register-key-server stdout for the stub e2e path', () => {
		expect(parseRegisterKeyServerOutput('key_server_object_id: 0xabc123\n')).toEqual({
			objectId: '0xabc123',
		});
	});

	it('builds the SDK register Move call with the signer sender and BLS public key bytes', () => {
		const tx = new FakeRegisterTx();

		buildRegisterKeyServerMoveCall(tx, registerInputs, '0xsigner');

		expect(tx.sender).toBe('0xsigner');
		expect(tx.target).toBe('0x1234::key_server::create_and_transfer_v2_independent_server');
		expect(tx.arguments).toEqual([
			{ kind: 'string', value: 'devstack-local' },
			{ kind: 'string', value: 'http://seal.seal.app.localhost' },
			{ kind: 'u8', value: 0 },
			{ kind: 'vector', type: 'u8', value: [10, 11, 12] },
		]);
	});

	it('picks the created KeyServer object from SDK execute effects', () => {
		expect(
			pickCreatedKeyServerObjectId({
				digest: '0xdigest',
				objectChanges: [
					{
						objectId: '0xother',
						objectType: '0x2::coin::CoinMetadata<0x2::sui::SUI>',
						idOperation: 'Created',
					},
					{
						objectId: '0xkeyserver',
						objectType: '0x1234::key_server::KeyServer',
						idOperation: 'Created',
					},
				],
			}),
		).toBe('0xkeyserver');
	});

	it('fails with register context when SDK effects omit the KeyServer object', async () => {
		const exit = await Effect.runPromiseExit(
			projectRegisterKeyServerReceipt('seal', {
				digest: '0xdigest',
				objectChanges: [],
			}),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('SealError');
			expect(err.value.phase).toBe('register');
			expect(err.value.message).toContain('created no ::key_server::KeyServer object');
			expect(err.value.message).toContain('0xdigest');
		}
	});
});
