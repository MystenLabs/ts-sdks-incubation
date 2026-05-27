import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';

import type { ContainerRuntime, OneShotSpec } from '../../../src/contracts/container-runtime.ts';
import { MoveSummaryRunnerService } from '../../../src/orchestrators/codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerDocker } from '../../../src/plugins/sui/move-summary-runner.ts';
import { ContainerRuntimeService } from '../../../src/runtime/docker/service.ts';

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

describe('codegen Move summary runner', () => {
	it.effect('runs sui move summary through the container runtime', () =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'devstack-summary-')));
			let cleanupPath: string | undefined;
			const previousHome = process.env.HOME;
			try {
				const sourcePath = join(root, 'hello');
				const home = join(root, 'home');
				process.env.HOME = home;
				mkdirSync(sourcePath, { recursive: true });
				writeFileSync(join(sourcePath, 'Move.toml'), '[package]\nname = "hello"\n');

				const capturedSpecs: OneShotSpec[] = [];
				const buildContexts: Parameters<ContainerRuntime['ensureImage']>[0][] = [];
				const runtime: ContainerRuntime = {
					...oneShotRuntime((spec) =>
						Effect.sync(() => {
							capturedSpecs.push(spec);
							const summaryMount = spec.mounts?.find((mount) => mount.target === '/summary');
							const moveMount = spec.mounts?.find((mount) => mount.target === '/root/.move');
							expect(summaryMount).toBeDefined();
							expect(existsSync(join(summaryMount!.source, 'Move.toml'))).toBe(true);
							expect(moveMount).toBeDefined();
							expect(moveMount!.source).toBe(join(home, '.move'));
							expect(existsSync(moveMount!.source)).toBe(true);
							expect(spec.image).toEqual({ digest: 'sha256:default-sui' });
							expect(spec.entrypoint).toBe('sh');
							expect(spec.argv?.[1]).toContain('sui move summary');
							expect(spec.argv?.[1]).toContain("/workspace/'hello'");
							expect(spec.argv?.[1]).toContain('trap cleanup_summary EXIT');
							expect(spec.argv?.[1]).toContain('chmod -R a+rwX /summary');
							expect(spec.argv?.[1]).toContain(
								`chown -R ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /summary`,
							);
							mkdirSync(join(summaryMount!.source, 'package_summaries', 'hello'), {
								recursive: true,
							});
							writeFileSync(
								join(summaryMount!.source, 'package_summaries', 'hello', 'hello.json'),
								'{}',
							);
							return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
						}),
					),
					ensureImage: (context) =>
						Effect.sync(() => {
							buildContexts.push(context);
							return { digest: 'sha256:default-sui' };
						}),
				};

				const summary = yield* Effect.gen(function* () {
					const runner = yield* MoveSummaryRunnerService;
					return yield* runner.runSummary({
						packageName: 'hello',
						sourcePath,
					});
				}).pipe(
					Effect.provide(layerSuiMoveSummaryRunnerDocker),
					Effect.provideService(ContainerRuntimeService, runtime),
				);

				cleanupPath = summary.cleanupPath;
				expect(summary).toMatchObject({
					packageName: 'hello',
					sourcePath,
					summaryJson: { ok: true },
				});
				expect(summary.summaryPath).toBeDefined();
				expect(capturedSpecs).toHaveLength(1);
				expect(buildContexts).toEqual([
					{
						contextPath: new URL('../../../images/', import.meta.url).pathname,
						dockerfile: 'sui/Dockerfile',
						fingerprintPaths: ['sui/Dockerfile', 'sui/entrypoint.sh', '_shared/signal-forward.sh'],
						buildArgs: { SUI_VERSION: 'devnet-v1.71.0' },
					},
				]);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
				if (cleanupPath !== undefined) rmSync(cleanupPath, { recursive: true, force: true });
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
