// Unit tests for the walrus deploy-output parser. The parser shape
// is the contract between the `walrus-deploy` binary's stdout/output
// file and the plugin's `CachedDeployState` shape — any drift in the
// upstream output format surfaces here.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Stream, type Scope } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import type {
	OnChainArtifactError,
	OnChainArtifactPublisher,
	OnChainArtifactSpec,
} from '../../../src/primitives/on-chain-artifact.ts';
import { makeSuiChainProbe, type SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';
import {
	deployWalrusContracts,
	parseDeployOutput,
	runDeployOneShot,
	type CachedDeployState,
	type DeployInputs,
} from '../../../src/plugins/walrus/deploy.ts';
import { chainId, contentHash } from '../../../src/substrate/brand.ts';

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
	saveImages: () => Stream.empty,
	loadImage: unusedRuntimeMethod,
	tagImage: unusedRuntimeMethod,
	removeImage: unusedRuntimeMethod,
	unpause: unusedRuntimeMethod,
	stop: unusedRuntimeMethod,
	sweepOrphans: unusedRuntimeMethod,
	removeManagedContainers: unusedRuntimeMethod,
	removeManagedImages: unusedRuntimeMethod,
	removeManagedNetworks: unusedRuntimeMethod,
	removeManagedVolumes: unusedRuntimeMethod,
});

const deployInputs = (): DeployInputs => ({
	walrusName: 'walrus',
	chainId: chainId('sui:localnet'),
	contentHash: contentHash('walrus-test'),
	outputDirHostPath: '/tmp/devstack/walrus/deploy',
	suiRpcUrlInNetwork: 'http://host.docker.internal:9123',
	walrusFaucetUrlInNetwork: 'http://host.docker.internal:9123/v2/gas',
	committeeSize: 4,
	shards: 100,
	epochDuration: '24h',
	publicHostsCsv: 'a,b,c,d',
	listeningIpsCsv: '10.0.0.10,10.0.0.11,10.0.0.12,10.0.0.13',
	walrusImage: { digest: 'walrus:test' },
	suiNetworkName: 'devstack-test-sui',
});

const cachedWalrusDeployState = (): CachedDeployState => ({
	walrusPackageId: '0xwalruspackage',
	systemObject: '0xsystem',
	stakingObject: '0xstaking',
	exchangeObject: '0xexchange',
});

const hostBindMountOwnerForTest = (): string | undefined => {
	const process = (
		globalThis as {
			process?: { getuid?: () => number; getgid?: () => number };
		}
	).process;
	if (typeof process?.getuid !== 'function' || typeof process.getgid !== 'function') {
		return undefined;
	}
	return `${process.getuid()}:${process.getgid()}`;
};

describe('parseDeployOutput', () => {
	it('extracts package_id / system_object / staking_object from key:value lines', () => {
		const stdout = [
			'package_id: 0xabc111',
			'system_object: 0xabc222',
			'staking_object: 0xabc333',
			'exchange_object: 0xabc444',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xabc111');
		expect(out!.systemObject).toBe('0xabc222');
		expect(out!.stakingObject).toBe('0xabc333');
		expect(out!.exchangeObject).toBe('0xabc444');
	});

	it('also matches the longer `walrus_package_id` key', () => {
		const stdout = [
			'walrus_package_id: 0xdef111',
			'system_object: 0xdef222',
			'staking_object: 0xdef333',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xdef111');
	});

	it('treats `None` as absent for optional fields', () => {
		const stdout = [
			'package_id: 0xeee111',
			'system_object: 0xeee222',
			'staking_object: 0xeee333',
			'exchange_object: None',
			'upgrade_manager_object: None',
			'treasury_object: None',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.exchangeObject).toBeUndefined();
		expect(out!.upgradeManagerObject).toBeUndefined();
		expect(out!.treasuryObject).toBeUndefined();
	});

	it('returns null when any required field is missing', () => {
		// Missing staking_object — should fail to parse.
		const stdout = ['package_id: 0xddd111', 'system_object: 0xddd222'].join('\n');
		expect(parseDeployOutput(stdout)).toBeNull();
	});

	it('is tolerant of surrounding chatter (walrus-deploy logs around the summary)', () => {
		const stdout = [
			'2026-05-20T12:34:56.789Z  INFO walrus_deploy: starting deploy',
			'2026-05-20T12:34:57.000Z  INFO walrus_deploy: faucet ok',
			'==== deploy-walrus summary ====',
			'package_id: 0xfff111',
			'system_object: 0xfff222',
			'staking_object: 0xfff333',
			'exchange_object: 0xfff444',
			'2026-05-20T12:35:01.000Z  INFO walrus_deploy: done',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xfff111');
		expect(out!.exchangeObject).toBe('0xfff444');
	});

	it('tolerates an `=` separator as well as `:`', () => {
		const stdout = [
			'package_id = 0xc1c1c1',
			'system_object = 0xc2c2c2',
			'staking_object = 0xc3c3c3',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xc1c1c1');
	});

	it.effect('passes host uid/gid so bind-mounted deploy output remains snapshot-readable', () =>
		Effect.gen(function* () {
			const expectedOwner = hostBindMountOwnerForTest();
			const runtime = oneShotRuntime((spec) => {
				expect(spec.env).toEqual(
					expectedOwner === undefined ? undefined : { DEVSTACK_HOST_UID_GID: expectedOwner },
				);
				return Effect.succeed({
					exitCode: 0,
					stdout: [
						'package_id: 0xabc111',
						'system_object: 0xabc222',
						'staking_object: 0xabc333',
					].join('\n'),
					stderr: '',
				});
			});

			const state = yield* Effect.scoped(runDeployOneShot(runtime, deployInputs()));
			expect(state.walrusPackageId).toBe('0xabc111');
		}),
	);

	it.effect('reports missing walrus-deploy as a typed deploy failure with stderr context', () =>
		Effect.gen(function* () {
			const runtime = oneShotRuntime((spec) => {
				expect(spec.argv?.[0]).toBe('deploy');
				return Effect.succeed({
					exitCode: 127,
					stdout: '',
					stderr:
						'deploy-walrus: walrus-deploy binary is missing or not executable at /opt/walrus/bin/walrus-deploy',
				});
			});

			const exit = yield* Effect.scoped(
				runDeployOneShot(runtime, deployInputs()).pipe(Effect.exit),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				expect(error.value._tag).toBe('WalrusPluginError');
				expect(error.value.phase).toBe('deploy');
				expect(error.value.message).toContain('walrus deploy exited with code 127');
				expect(error.value.message).toContain('exit 127 usually means');
				expect(error.value.message).toContain('walrus-deploy binary is missing');
			}
		}),
	);

	it.effect('verifies cached system and staking objects without re-running walrus-deploy', () =>
		Effect.gen(function* () {
			const cached = cachedWalrusDeployState();
			const requestedObjects: string[] = [];
			const sdk: SuiSdkShim = {
				core: {
					getObject: async ({ objectId }) => {
						requestedObjects.push(objectId);
						if (objectId !== cached.systemObject && objectId !== cached.stakingObject) {
							throw new Error(`object not found: ${objectId}`);
						}
						return { object: { objectId } };
					},
					getTransaction: async () => ({}),
					executeTransaction: async () => ({}),
					waitForTransaction: async () => ({}),
				},
				client: {},
			};
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');
			const publisher: OnChainArtifactPublisher = {
				publish: <Produced, Verified>(
					spec: OnChainArtifactSpec<Produced, Verified>,
				): Effect.Effect<Produced | Verified, OnChainArtifactError, Scope.Scope> =>
					Effect.gen(function* () {
						const verified = yield* spec.verify(cached as unknown as Produced);
						if (verified !== null) return cached as unknown as Produced;
						return yield* spec.produce;
					}),
			};
			const runtime = oneShotRuntime(() =>
				Effect.die('walrus-deploy should not run on a verified cache hit'),
			);

			const result = yield* Effect.scoped(
				deployWalrusContracts(publisher, probe, runtime, deployInputs()),
			);

			expect(result.state).toEqual(cached);
			expect(requestedObjects).toEqual([cached.systemObject, cached.stakingObject]);
		}),
	);
});
