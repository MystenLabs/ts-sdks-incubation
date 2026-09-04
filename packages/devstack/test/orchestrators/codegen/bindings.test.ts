import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { generateFromPackageSummary } from '@mysten/codegen';
import { Effect } from 'effect';
import { vi } from 'vitest';

import type { MoveToolchain } from '../../../src/contracts/codegenable.ts';
import type { ContainerRuntime, OneShotSpec } from '../../../src/contracts/container-runtime.ts';
import {
	layerMystenMoveCodegen,
	MoveCodegenService,
	MoveSummaryRunnerService,
} from '../../../src/orchestrators/codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerDocker } from '../../../src/plugins/sui/move-summary-runner.ts';
import { SUI_TOOLS_REF_ENV_VAR, suiToolsImage } from '../../../src/plugins/sui/move/index.ts';
import { ContainerRuntimeService } from '../../../src/runtime/docker/service.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

// The summary image resolver reads DEVSTACK_SUI_TOOLS_REF; pin the bundled
// sui-tools ref regardless of what the developer's shell exports.
beforeEach(() => {
	vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

// Replace the heavyweight `@mysten/codegen` renderer with a spy so the
// `layerMystenMoveCodegen` tests below can assert exactly what reaches
// `generateFromPackageSummary` without rendering a real package summary.
// (The Docker summary-runner test in this file never invokes it.)
vi.mock('@mysten/codegen', () => ({
	generateFromPackageSummary: vi.fn(async () => {}),
}));

const generateFromPackageSummaryMock = vi.mocked(generateFromPackageSummary);

const oneShotRuntime = (runOneShot: ContainerRuntime['runOneShot']): ContainerRuntime =>
	makeContainerRuntimeStub({ runOneShot });

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
				// A pinned Move.lock proves the runner mounts a disposable COPY at
				// /workspace, not the developer's real source — `sui move summary`
				// would rewrite this lock in place otherwise.
				const sourceLock = '[move]\nversion = 3\n[pinned.testnet.dep]\npublished-at = "0x1"\n';
				writeFileSync(join(sourcePath, 'Move.lock'), sourceLock);

				const capturedSpecs: OneShotSpec[] = [];
				let expectedImage = { digest: 'sha256:default-sui' };
				const buildContexts: Parameters<ContainerRuntime['ensureImage']>[0][] = [];
				const runtime: ContainerRuntime = {
					...oneShotRuntime((spec) =>
						Effect.sync(() => {
							capturedSpecs.push(spec);
							const summaryMount = spec.mounts?.find((mount) => mount.target === '/summary');
							const workspaceMount = spec.mounts?.find((mount) => mount.target === '/workspace');
							const moveMount = spec.mounts?.find((mount) => mount.target === '/root/.move');
							expect(summaryMount).toBeDefined();
							expect(workspaceMount).toBeDefined();
							// /workspace is a disposable staged COPY of the package, never the
							// real source parent — so `sui move summary` rewrites the copy's
							// Move.lock, not the developer's checked-in tree.
							expect(workspaceMount!.source).not.toBe(root);
							expect(existsSync(join(workspaceMount!.source, 'hello', 'Move.toml'))).toBe(true);
							expect(existsSync(join(workspaceMount!.source, 'hello', 'Move.lock'))).toBe(true);
							expect(moveMount).toBeDefined();
							expect(moveMount!.source).toBe(join(home, '.move'));
							expect(existsSync(moveMount!.source)).toBe(true);
							expect(spec.image).toEqual(expectedImage);
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
				// The developer's real source Move.lock is never mutated.
				expect(readFileSync(join(sourcePath, 'Move.lock'), 'utf8')).toBe(sourceLock);
				expect(capturedSpecs).toHaveLength(1);
				expect(buildContexts).toEqual([
					{
						contextPath: fileURLToPath(new URL('../../../images/', import.meta.url)),
						dockerfile: 'sui/Dockerfile',
						fingerprintPaths: [
							'sui/Dockerfile',
							'sui/entrypoint.sh',
							'sui-fork/entrypoint.sh',
							'_shared/signal-forward.sh',
						],
						buildArgs: {
							SUI_TOOLS_IMAGE: `mysten/sui-tools:eced02468444d429a4e9a2b9622b7bd30a1710d4${
								process.arch === 'arm64' ? '-arm64' : ''
							}`,
						},
					},
				]);

				const runWith = (moveToolchain: MoveToolchain) =>
					Effect.gen(function* () {
						const runner = yield* MoveSummaryRunnerService;
						const out = yield* runner.runSummary({
							packageName: 'hello',
							sourcePath,
							moveToolchain,
						});
						if (out.cleanupPath !== undefined) {
							rmSync(out.cleanupPath, { recursive: true, force: true });
						}
					}).pipe(
						Effect.provide(layerSuiMoveSummaryRunnerDocker),
						Effect.provideService(ContainerRuntimeService, runtime),
					);

				// A sui-tools toolchain (stack-free codegen) moves the summary CLI off
				// the bundled pin onto the ref the stack's image plan resolved to.
				yield* runWith({ kind: 'sui-tools', suiToolsRef: 'testnet-v1.80.0', explicit: true });
				expect(buildContexts[1]?.buildArgs).toEqual({
					SUI_TOOLS_IMAGE: suiToolsImage('testnet-v1.80.0'),
				});

				// An exact image toolchain (live boot) is used as is: no build at all.
				expectedImage = { digest: 'sha256:the-stacks-build-image' };
				yield* runWith({ kind: 'image', image: expectedImage });
				expect(buildContexts).toHaveLength(2);
				expect(capturedSpecs[2]?.image).toEqual(expectedImage);
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

describe('layerMystenMoveCodegen', () => {
	// A nonexistent sourcePath is deliberate: `resolveSummaryDirName` falls
	// back to the symbolic package name when the source Move.toml is
	// unreadable, so no fixture tree is needed to exercise the generate seam.
	const generateInput = (sourcePath: string) => ({
		packageName: 'hello',
		sourcePath,
		summary: {
			packageName: 'hello',
			sourcePath,
			summaryPath: join(sourcePath, 'summary'),
			summaryJson: {},
		},
		mvrPlaceholder: '@local-pkg/hello',
		importExtension: '.ts' as const,
	});

	it.effect('threads includePhantomTypeParameters into generateFromPackageSummary', () =>
		Effect.gen(function* () {
			generateFromPackageSummaryMock.mockClear();
			const sourcePath = join(tmpdir(), 'devstack-phantom-on-nonexistent');
			const generator = yield* MoveCodegenService;
			yield* generator.generate(generateInput(sourcePath));
			expect(generateFromPackageSummaryMock).toHaveBeenCalledTimes(1);
			expect(generateFromPackageSummaryMock.mock.calls[0]![0]).toMatchObject({
				package: {
					path: join(sourcePath, 'summary'),
					package: '@local-pkg/hello',
					packageName: 'hello',
				},
				importExtension: '.ts',
				includePhantomTypeParameters: true,
			});
		}).pipe(Effect.provide(layerMystenMoveCodegen({ includePhantomTypeParameters: true }))),
	);

	it.effect('leaves includePhantomTypeParameters unset by default (zero-arg layer)', () =>
		Effect.gen(function* () {
			generateFromPackageSummaryMock.mockClear();
			const sourcePath = join(tmpdir(), 'devstack-phantom-default-nonexistent');
			const generator = yield* MoveCodegenService;
			yield* generator.generate(generateInput(sourcePath));
			expect(generateFromPackageSummaryMock).toHaveBeenCalledTimes(1);
			// `undefined`, not a devstack-forced `false`: `@mysten/codegen`'s
			// own destructuring default applies, so default output stays
			// byte-identical to the pre-option behavior.
			expect(
				generateFromPackageSummaryMock.mock.calls[0]![0].includePhantomTypeParameters,
			).toBeUndefined();
		}).pipe(Effect.provide(layerMystenMoveCodegen())),
	);
});
