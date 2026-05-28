// Unit tests for the walrus deploy-output parser. The parser shape
// is the contract between the `walrus-deploy` binary's stdout/output
// file and the plugin's `CachedDeployState` shape — any drift in the
// upstream output format surfaces here.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Stream, type Scope } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import type {
	ArtifactPublishError,
	ArtifactPublisher,
	ArtifactSpec,
} from '../../../src/primitives/artifact-publisher.ts';
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
	pause: unusedRuntimeMethod,
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

const deployInputs = (
	outputDirHostPath = '/tmp/devstack/stacks/main/walrus/walrus/deploy',
): DeployInputs => ({
	walrusName: 'walrus',
	chainId: chainId('sui:localnet'),
	contentHash: contentHash('walrus-test'),
	outputDirHostPath,
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

const writeDeployOutputFiles = (dir: string, state: CachedDeployState, nodeCount = 4) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'deploy'),
		[
			`walrus_package_id: ${state.walrusPackageId}`,
			`system_object: ${state.systemObject}`,
			`staking_object: ${state.stakingObject}`,
		].join('\n'),
	);
	for (let index = 0; index < nodeCount; index += 1) {
		writeFileSync(join(dir, `dryrun-node-${index}.yaml`), 'node config\n');
		writeFileSync(join(dir, `dryrun-node-${index}-sui.yaml`), 'sui config\n');
		writeFileSync(join(dir, `dryrun-node-${index}.keystore`), '[]\n');
	}
};

const tempDeployOutputDir = (prefix: string): string => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const outputDir = join(root, 'stacks', 'main', 'walrus', 'walrus', 'deploy');
	mkdirSync(outputDir, { recursive: true });
	return outputDir;
};

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
			const outputDir = '/tmp/devstack/stacks/main/walrus/walrus/deploy';
			const runtime = oneShotRuntime((spec) => {
				expect(spec.argv?.slice(0, 3)).toEqual([
					'deploy',
					'--output-dir',
					'/opt/walrus/runtime/walrus/walrus/deploy',
				]);
				expect(spec.mounts).toEqual([
					{
						source: '/tmp/devstack/stacks/main',
						target: '/opt/walrus/runtime',
					},
				]);
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

			const state = yield* Effect.scoped(runDeployOneShot(runtime, deployInputs(outputDir)));
			expect(state.walrusPackageId).toBe('0xabc111');
		}),
	);

	it.effect('waits for the centralized Sui funds-ready gate before walrus-deploy', () =>
		Effect.gen(function* () {
			const events: string[] = [];
			const runtime = oneShotRuntime(() => {
				events.push('deploy');
				expect(events).toEqual(['funds-ready', 'deploy']);
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

			const state = yield* Effect.scoped(
				runDeployOneShot(runtime, {
					...deployInputs(),
					waitForFundsReady: Effect.sync(() => {
						events.push('funds-ready');
					}),
				}),
			);

			expect(state.walrusPackageId).toBe('0xabc111');
			expect(events).toEqual(['funds-ready', 'deploy']);
		}),
	);

	it.effect('does not start walrus-deploy when the funds-ready gate fails', () =>
		Effect.gen(function* () {
			const runtime = oneShotRuntime(() => Effect.die('walrus-deploy should not run'));

			const exit = yield* Effect.scoped(
				runDeployOneShot(runtime, {
					...deployInputs(),
					waitForFundsReady: Effect.fail(new Error('faucet not funds-ready')),
				}).pipe(Effect.exit),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(Option.isSome(error)).toBe(true);
			if (Option.isSome(error)) {
				expect(error.value._tag).toBe('WalrusPluginError');
				expect(error.value.phase).toBe('deploy');
				expect(error.value.message).toContain('funding gate failed before walrus-deploy');
				expect(error.value.message).toContain('faucet not funds-ready');
			}
		}),
	);

	it.live('retries Docker Desktop bind-source visibility races', () =>
		Effect.gen(function* () {
			const outputDir = tempDeployOutputDir('devstack-walrus-bind-race-');
			let attempts = 0;
			const runtime = oneShotRuntime(() => {
				attempts += 1;
				if (attempts === 1) {
					return Effect.succeed({
						exitCode: 125,
						stdout: '',
						stderr:
							'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /host_mnt/tmp/devstack/walrus/deploy',
					});
				}
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

			const state = yield* Effect.scoped(runDeployOneShot(runtime, deployInputs(outputDir)));

			expect(attempts).toBe(2);
			expect(state.walrusPackageId).toBe('0xabc111');
			expect(existsSync(join(outputDir, '.devstack-bind-source'))).toBe(true);
			expect(readFileSync(join(outputDir, '.devstack-bind-source'), 'utf8')).toContain(
				'devstack walrus bind source',
			);
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
			const outputDir = tempDeployOutputDir('devstack-walrus-deploy-');
			writeDeployOutputFiles(outputDir, cached);
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
					getBalance: async () => ({}),
					listCoins: async () => ({ objects: [], hasNextPage: false, cursor: null }),
					executeTransaction: async () => ({}),
					waitForTransaction: async () => ({}),
				},
				client: {} as never,
			};
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');
			const publisher: ArtifactPublisher = {
				publish: <Produced, Verified>(
					spec: ArtifactSpec<Produced, Verified>,
				): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
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
				deployWalrusContracts(publisher, probe, runtime, deployInputs(outputDir)),
			);

			// Regression: backlog #1. The substrate now hands back the
			// decoded `CachedDeployState` on verify-hit. The walrus
			// caller MUST surface the originally-produced packageId
			// verbatim — NOT the historical `'<cache-hit-not-rehydrated>'`
			// sentinel string.
			expect(result.state).toEqual(cached);
			expect(result.state.walrusPackageId).toBe(cached.walrusPackageId);
			expect(result.state.walrusPackageId).not.toMatch(/^</);
			expect(requestedObjects).toEqual([cached.systemObject, cached.stakingObject]);
		}),
	);

	it.effect('treats missing local deploy outputs as a cache miss', () =>
		Effect.gen(function* () {
			const cached = cachedWalrusDeployState();
			const outputDir = tempDeployOutputDir('devstack-walrus-missing-deploy-');
			const requestedObjects: string[] = [];
			const sdk: SuiSdkShim = {
				core: {
					getObject: async ({ objectId }) => {
						requestedObjects.push(objectId);
						return { object: { objectId } };
					},
					getTransaction: async () => ({}),
					getBalance: async () => ({}),
					listCoins: async () => ({ objects: [], hasNextPage: false, cursor: null }),
					executeTransaction: async () => ({}),
					waitForTransaction: async () => ({}),
				},
				client: {} as never,
			};
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');
			const publisher: ArtifactPublisher = {
				publish: <Produced, Verified>(
					spec: ArtifactSpec<Produced, Verified>,
				): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
					Effect.gen(function* () {
						const verified = yield* spec.verify(cached as unknown as Produced);
						if (verified !== null) return cached as unknown as Produced;
						return yield* spec.produce;
					}),
			};
			const runtime = oneShotRuntime(() =>
				Effect.succeed({
					exitCode: 0,
					stdout: [
						'package_id: 0xa1a1a1a1a1a1a1a1',
						'system_object: 0xb2b2b2b2b2b2b2b2',
						'staking_object: 0xc3c3c3c3c3c3c3c3',
					].join('\n'),
					stderr: '',
				}),
			);

			const result = yield* Effect.scoped(
				deployWalrusContracts(publisher, probe, runtime, deployInputs(outputDir)),
			);

			expect(result.state).toEqual({
				walrusPackageId: '0xa1a1a1a1a1a1a1a1',
				systemObject: '0xb2b2b2b2b2b2b2b2',
				stakingObject: '0xc3c3c3c3c3c3c3c3',
			});
			expect(requestedObjects).toEqual([]);
		}),
	);
});
