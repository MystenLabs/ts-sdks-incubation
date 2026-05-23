// Codegen orchestrator — service-level tests.
//
// Exercises uniqueness validation (path collision + emitter
// collision), the package-emitter exception, and the full cycle
// against the real Node FileSystem with stubbed Move generators.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { FileSystem } from 'effect';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Subpath imports — the barrel re-exports `NodeRedis` which transitively
// requires `ioredis`, an optional peer not installed in this package.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import type { CodegenableDecl, CodegenEmitContext } from '../../../src/contracts/codegenable.ts';

import {
	MoveCodegenService,
	MoveSummaryRunnerService,
	stubMoveCodegen,
	stubMoveSummaryRunner,
} from '../../../src/orchestrators/codegen/bindings.ts';
import { makeExtrasCodegenable } from '../../../src/orchestrators/codegen/extras.ts';
import {
	CodegenEmitterCollision,
	CodegenPathConflict,
} from '../../../src/orchestrators/codegen/errors.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../../src/orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../../src/orchestrators/codegen/service.ts';

// Helper — synthesise a Codegenable for tests.
const writeExports = (
	ctx: CodegenEmitContext,
	exports: { readonly [key: string]: unknown },
): void => {
	for (const [key, value] of Object.entries(exports)) {
		ctx.exportConst(key, value);
	}
};

const fakeDecl = (parts: {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly sensitive?: boolean;
	readonly exports: { readonly [key: string]: unknown };
}): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: parts.emitterName,
	outputPath: parts.outputPath,
	sensitive: parts.sensitive,
	emit: (ctx) =>
		Effect.sync(() => {
			writeExports(ctx, parts.exports);
			return ctx.done();
		}),
});

const stubMoveLayers = Layer.mergeAll(
	Layer.succeed(MoveSummaryRunnerService)(
		stubMoveSummaryRunner((sourcePath) => ({
			packageName: sourcePath,
			sourcePath,
			summaryJson: {},
		})),
	),
	Layer.succeed(MoveCodegenService)(
		stubMoveCodegen((input) => [
			{
				relPath: `${input.packageName}/index.ts`,
				content: `export const ID = "${input.mvrPlaceholder}";\n`,
			},
		]),
	),
);

const nodePlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const baseLayer = (root: string) =>
	Layer.mergeAll(stubMoveLayers, layerCodegenPaths, nodePlatformLayer).pipe(
		Layer.provide(layerCodegenRoot({ outputDir: root, stackSubdir: null })),
		Layer.provide(nodePlatformLayer),
	);

const baseLayerWithMove = (
	root: string,
	moveLayers: Layer.Layer<MoveCodegenService | MoveSummaryRunnerService>,
) =>
	Layer.mergeAll(moveLayers, layerCodegenPaths, nodePlatformLayer).pipe(
		Layer.provide(layerCodegenRoot({ outputDir: root, stackSubdir: null })),
		Layer.provide(nodePlatformLayer),
	);

describe('codegen.runEmitCycle', () => {
	it.effect('evaluates each package emitter once while collecting bindings', () => {
		const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			let emits = 0;
			const packageDecl: CodegenableDecl<string> = {
				kind: 'codegenable',
				emitterName: 'package',
				outputPath: 'package/single.ts',
				emit: (ctx) =>
					Effect.sync(() => {
						emits += 1;
						ctx.exportConst('packageBindings', {
							name: 'single',
							packageId: '0x1',
							mvrPlaceholder: '@local/single',
							sourcePath: '/tmp/source/single',
							excluded: false,
						});
						return ctx.done();
					}),
			};

			const result = yield* runEmitCycle({ contributions: [packageDecl] });
			expect(emits).toBe(1);
			expect(result.bindings?.packagesEmitted).toEqual(['single']);
			yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
		}).pipe(Effect.provide(baseLayer(root)));
	});

	it.effect('refuses duplicate output paths', () =>
		Effect.gen(function* () {
			const result = yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'a',
						outputPath: 'same.ts',
						exports: { a: 1 },
					}),
					fakeDecl({
						emitterName: 'b',
						outputPath: 'same.ts',
						exports: { b: 1 },
					}),
				],
			}).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CodegenPathConflict);
		}).pipe(Effect.provide(baseLayer('/tmp/codegen-test-1'))),
	);

	it.effect('refuses two non-package emitters with the same name', () =>
		Effect.gen(function* () {
			const result = yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'same-name',
						outputPath: 'a.ts',
						exports: { a: 1 },
					}),
					fakeDecl({
						emitterName: 'same-name',
						outputPath: 'b.ts',
						exports: { b: 1 },
					}),
				],
			}).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CodegenEmitterCollision);
		}).pipe(Effect.provide(baseLayer('/tmp/codegen-test-2'))),
	);

	it.effect('allows multiple `package` emitters (per-Package exception)', () => {
		const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const result = yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'package',
						outputPath: 'package/p1.ts',
						exports: {
							packageBindings: {
								name: 'p1',
								packageId: '0xaa',
								mvrPlaceholder: '@local/p1',
								sourcePath: null,
								excluded: true,
							},
						},
					}),
					fakeDecl({
						emitterName: 'package',
						outputPath: 'package/p2.ts',
						exports: {
							packageBindings: {
								name: 'p2',
								packageId: '0xbb',
								mvrPlaceholder: '@local/p2',
								sourcePath: null,
								excluded: true,
							},
						},
					}),
				],
			});
			expect(result.filesWritten.length + result.filesUnchanged.length).toBeGreaterThan(0);
			// Both packages have sourcePath=null → bindings emitter
			// runs but skips both; emitted list is empty, skipped list
			// holds both.
			expect(result.bindings).not.toBeNull();
			expect(result.bindings!.packagesEmitted).toEqual([]);
			expect([...result.bindings!.packagesSkipped].sort()).toEqual(['p1', 'p2']);
			yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
		}).pipe(Effect.provide(baseLayer(root)));
	});

	it.effect('emits idempotently — second cycle reports unchanged', () => {
		const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const contributions = [
				fakeDecl({
					emitterName: 'sui-network',
					outputPath: 'sui/network.ts',
					exports: { suiNetwork: { chain: 'sui:local', rpcUrl: 'http://x' } },
				}),
			];
			const r1 = yield* runEmitCycle({ contributions });
			expect(r1.filesWritten.length).toBeGreaterThan(0);
			const r2 = yield* runEmitCycle({ contributions });
			// On second cycle, the file is on disk and content matches —
			// emit reports unchanged.
			expect(r2.filesWritten.length).toBe(0);
			expect(r2.filesUnchanged.length).toBeGreaterThan(0);
			yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
		}).pipe(Effect.provide(baseLayer(root)));
	});

	it.effect('emits aggregate app-facing accounts coins packages and services files', () => {
		const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const result = yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'account/alice',
						outputPath: 'accounts/alice.ts',
						exports: {
							alice: {
								name: 'alice',
								address: '0xabc',
								scheme: 'ed25519',
								source: 'real',
							},
						},
					}),
					fakeDecl({
						emitterName: 'coin/mock_usdc',
						outputPath: 'coins/mock_usdc.ts',
						exports: {
							mock_usdc: {
								symbol: 'mock_usdc',
								fullCoinType: '0x1::mock_usdc::MOCK_USDC',
								decimals: 6,
								source: 'registry',
							},
						},
					}),
					fakeDecl({
						emitterName: 'sui-network',
						outputPath: 'sui/network.ts',
						exports: {
							suiNetwork: {
								chain: 'sui:local',
								mode: 'local',
								rpcUrl: 'http://127.0.0.1:9000',
								faucetUrl: 'http://127.0.0.1:9123',
								graphqlUrl: null,
							},
						},
					}),
					fakeDecl({
						emitterName: 'package',
						outputPath: 'package/mock-usdc.ts',
						exports: {
							packageBindings: {
								name: 'mock_usdc',
								packageId: '0x1',
								mvrPlaceholder: 'mock-usdc',
								sourcePath: null,
								excluded: true,
							},
						},
					}),
					makeExtrasCodegenable({
						openLobbyId: '0xfeed',
						sealKeyServer: {
							objectId: '0xseal',
							url: 'http://seal.localhost:5175',
						},
					}),
				],
			});
			expect(result.filesWritten.some((path) => path.endsWith('/accounts.ts'))).toBe(true);
			expect(result.filesWritten.some((path) => path.endsWith('/coins.ts'))).toBe(true);
			expect(result.filesWritten.some((path) => path.endsWith('/services.ts'))).toBe(true);
			expect(result.filesWritten.some((path) => path.endsWith('/packages.ts'))).toBe(true);
			expect(result.filesWritten.some((path) => path.endsWith('/extras.ts'))).toBe(true);
			expect(result.bindings?.packagesEmitted).toEqual([]);

			const accountsModule = yield* Effect.promise(
				() =>
					import(`${pathToFileURL(`${root}/accounts.ts`).href}?t=${Date.now()}`) as Promise<{
						readonly accounts: { readonly alice: { readonly address: string } };
					}>,
			);
			const coinsModule = yield* Effect.promise(
				() =>
					import(`${pathToFileURL(`${root}/coins.ts`).href}?t=${Date.now()}`) as Promise<{
						readonly coins: { readonly mock_usdc: { readonly fullCoinType: string } };
					}>,
			);
			const servicesModule = yield* Effect.promise(
				() =>
					import(`${pathToFileURL(`${root}/services.ts`).href}?t=${Date.now()}`) as Promise<{
						readonly services: { readonly sui: { readonly rpc: { readonly url: string } } };
					}>,
			);
			const packagesModule = yield* Effect.promise(
				() =>
					import(`${pathToFileURL(`${root}/packages.ts`).href}?t=${Date.now()}`) as Promise<{
						readonly packages: { readonly mock_usdc: { readonly packageId: string } };
					}>,
			);
			const extrasModule = yield* Effect.promise(
				() =>
					import(`${pathToFileURL(`${root}/extras.ts`).href}?t=${Date.now()}`) as Promise<{
						readonly extras: {
							readonly openLobbyId: string;
							readonly sealKeyServer: { readonly objectId: string; readonly url: string };
						};
					}>,
			);
			expect(accountsModule.accounts.alice.address).toBe('0xabc');
			expect(coinsModule.coins.mock_usdc.fullCoinType).toBe('0x1::mock_usdc::MOCK_USDC');
			expect(servicesModule.services.sui.rpc.url).toBe('http://127.0.0.1:9000');
			expect(packagesModule.packages.mock_usdc.packageId).toBe('0x1');
			expect(extrasModule.extras.openLobbyId).toBe('0xfeed');
			expect(extrasModule.extras.sealKeyServer.objectId).toBe('0xseal');
			yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
		}).pipe(Effect.provide(baseLayer(root)));
	});

	it.effect(
		'imports generated package pointer, aggregate, and Move binding modules without sui',
		() => {
			const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
			return Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const result = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'package',
							outputPath: 'package/hello.ts',
							exports: {
								packageBindings: {
									name: 'hello',
									packageId: '0x123',
									mvrPlaceholder: '@local/hello',
									sourcePath: '/tmp/source/hello',
									excluded: false,
								},
							},
						}),
					],
				});
				expect(result.bindings?.packagesEmitted).toEqual(['hello']);
				expect(
					result.bindings?.filesWritten.some((path) => path.endsWith('/bindings/hello/index.ts')),
				).toBe(true);

				const packageModule = yield* Effect.promise(
					() =>
						import(`${pathToFileURL(`${root}/package/hello.ts`).href}?t=${Date.now()}`) as Promise<{
							readonly packageBindings: { readonly packageId: string };
						}>,
				);
				const packagesModule = yield* Effect.promise(
					() =>
						import(`${pathToFileURL(`${root}/packages.ts`).href}?t=${Date.now()}`) as Promise<{
							readonly packages: { readonly hello: { readonly mvrPlaceholder: string } };
						}>,
				);
				const bindingsModule = yield* Effect.promise(
					() =>
						import(
							`${pathToFileURL(`${root}/bindings/hello/index.ts`).href}?t=${Date.now()}`
						) as Promise<{
							readonly ID: string;
						}>,
				);

				expect(packageModule.packageBindings.packageId).toBe('0x123');
				expect(packagesModule.packages.hello.mvrPlaceholder).toBe('@local/hello');
				expect(bindingsModule.ID).toBe('@local/hello');

				const second = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'package',
							outputPath: 'package/hello.ts',
							exports: {
								packageBindings: {
									name: 'hello',
									packageId: '0x123',
									mvrPlaceholder: '@local/hello',
									sourcePath: '/tmp/source/hello',
									excluded: false,
								},
							},
						}),
					],
				});
				expect(second.bindings?.filesWritten).toEqual([]);
				yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
			}).pipe(Effect.provide(baseLayer(root)));
		},
	);

	it.effect('adds portable return types to generic BCS factory bindings', () => {
		const root = `/tmp/codegen-test-${Date.now()}-${Math.random()}`;
		const moveLayers = Layer.mergeAll(
			Layer.succeed(MoveSummaryRunnerService)(
				stubMoveSummaryRunner((sourcePath) => ({
					packageName: sourcePath,
					sourcePath,
					summaryJson: {},
				})),
			),
			Layer.succeed(MoveCodegenService)(
				stubMoveCodegen((input) => [
					{
						relPath: `${input.packageName}/vec_set.ts`,
						content: `import { type BcsType, bcs } from '@mysten/sui/bcs';
import { MoveStruct } from '../utils/index.ts';
export function VecSet<K extends BcsType<any>>(...typeParameters: [
    K
]) {
    return new MoveStruct({ name: '0x2::vec_set::VecSet', fields: {
            contents: bcs.vector(typeParameters[0])
        } });
}
`,
					},
				]),
			),
		);
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'package',
						outputPath: 'package/hello.ts',
						exports: {
							packageBindings: {
								name: 'hello',
								packageId: '0x123',
								mvrPlaceholder: '@local/hello',
								sourcePath: '/tmp/source/hello',
								excluded: false,
							},
						},
					}),
				],
			});
			const output = yield* Effect.promise(() =>
				readFile(`${root}/bindings/hello/vec_set.ts`, 'utf8'),
			);
			expect(output).toContain(']): MoveStruct<any, string> {');
			yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
		}).pipe(Effect.provide(baseLayerWithMove(root, moveLayers)));
	});
});
