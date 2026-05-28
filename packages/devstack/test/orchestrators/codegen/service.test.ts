// Codegen orchestrator — service-level tests.
//
// Exercises uniqueness validation (path collision + emitter
// collision), the package-emitter exception, and the full cycle
// against the real Node FileSystem with stubbed Move generators.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { chmodSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Subpath imports — the barrel re-exports `NodeRedis` which transitively
// requires `ioredis`, an optional peer not installed in this package.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import type {
	AggregateContribution,
	CodegenableDecl,
	CodegenEmitContext,
} from '../../../src/contracts/codegenable.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

import {
	MoveCodegenService,
	MoveSummaryRunnerService,
	stubMoveCodegen,
	stubMoveSummaryRunner,
} from '../../../src/orchestrators/codegen/bindings.ts';
import {
	CodegenEmitterCollision,
	CodegenPathConflict,
} from '../../../src/orchestrators/codegen/errors.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../../src/orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../../src/orchestrators/codegen/service.ts';

// `makeExtrasCodegenable` was an internal one-call factory. Reproduced
// inline here so the codegen orchestrator's extras path stays under test
// without resurrecting a single-use module.
const makeExtrasCodegenable = (
	extras: Readonly<Record<string, unknown>>,
): CodegenableDecl<'app-extras'> => ({
	kind: 'codegenable',
	emitterName: 'app-extras',
	outputPath: 'extras.ts',
	sensitive: true,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('extras', extras);
			return ctx.done();
		}),
});

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
	readonly allowEmitterNameRepetition?: boolean;
	readonly aggregate?: AggregateContribution;
	readonly exports: { readonly [key: string]: unknown };
}): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: parts.emitterName,
	outputPath: parts.outputPath,
	sensitive: parts.sensitive,
	allowEmitterNameRepetition: parts.allowEmitterNameRepetition,
	aggregate: parts.aggregate,
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
	it.effect('evaluates each package emitter once while collecting bindings', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				let emits = 0;
				// Inline the package plugin's contract shape so this test
				// validates the orchestrator's name-blind consumption of
				// `aggregate.project` rather than naming the plugin.
				const packageDecl: CodegenableDecl<string> = {
					kind: 'codegenable',
					emitterName: 'package',
					outputPath: 'package/single.ts',
					allowEmitterNameRepetition: true,
					aggregate: {
						kind: 'package',
						bucket: 'packages.ts',
						project: (exported) => {
							const bindings = exported['packageBindings'];
							return typeof bindings === 'object' && bindings !== null
								? { [(bindings as { name: string }).name]: bindings }
								: null;
						},
					},
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
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

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

	it.effect('refuses two emitters with the same name when neither opts into repetition', () =>
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

	it.effect(
		'refuses a non-relative outputPath with CodegenPathConflict({kind:"non-relative"})',
		() =>
			Effect.gen(function* () {
				const result = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'escape',
							outputPath: '../escape.ts',
							exports: { a: 1 },
						}),
					],
				}).pipe(Effect.flip);
				expect(result).toBeInstanceOf(CodegenPathConflict);
				if (result instanceof CodegenPathConflict) {
					expect(result.kind).toBe('non-relative');
					expect(result.outputPath).toBe('../escape.ts');
				}
			}).pipe(Effect.provide(baseLayer('/tmp/codegen-test-non-relative'))),
	);

	it.effect('duplicate-path conflict carries kind: "duplicate"', () =>
		Effect.gen(function* () {
			const result = yield* runEmitCycle({
				contributions: [
					fakeDecl({
						emitterName: 'a',
						outputPath: 'dup.ts',
						exports: { a: 1 },
					}),
					fakeDecl({
						emitterName: 'b',
						outputPath: 'dup.ts',
						exports: { b: 1 },
					}),
				],
			}).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CodegenPathConflict);
			if (result instanceof CodegenPathConflict) {
				expect(result.kind).toBe('duplicate');
			}
		}).pipe(Effect.provide(baseLayer('/tmp/codegen-test-duplicate-kind'))),
	);

	it.effect('allows shared emitter names when allowEmitterNameRepetition is set', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				const result = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'package',
							outputPath: 'package/p1.ts',
							allowEmitterNameRepetition: true,
							exports: {
								packageBindings: {
									name: 'p1',
									packageId: '0xaa',
									mvrPlaceholder: '@local/p1',
									sourcePath: null,
									excluded: true,
								},
							},
							aggregate: {
								bucket: 'packages.ts',
								project: (e) => {
									const b = e['packageBindings'] as { name: string };
									return { [b.name]: b };
								},
							},
						}),
						fakeDecl({
							emitterName: 'package',
							outputPath: 'package/p2.ts',
							allowEmitterNameRepetition: true,
							exports: {
								packageBindings: {
									name: 'p2',
									packageId: '0xbb',
									mvrPlaceholder: '@local/p2',
									sourcePath: null,
									excluded: true,
								},
							},
							aggregate: {
								bucket: 'packages.ts',
								project: (e) => {
									const b = e['packageBindings'] as { name: string };
									return { [b.name]: b };
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
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect('emits idempotently — second cycle reports unchanged', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				const contributions = [
					fakeDecl({
						emitterName: 'sui-network',
						outputPath: 'sui/network.ts',
						exports: { suiNetwork: { chain: 'sui:local', rpcUrl: 'http://x' } },
						aggregate: {
							bucket: 'services.ts',
							project: (e) => {
								const n = e['suiNetwork'] as { rpcUrl: string };
								return { sui: { rpc: { url: n.rpcUrl } } };
							},
						},
					}),
				];
				const r1 = yield* runEmitCycle({ contributions });
				expect(r1.filesWritten.length).toBeGreaterThan(0);
				const r2 = yield* runEmitCycle({ contributions });
				// On second cycle, the file is on disk and content matches —
				// emit reports unchanged.
				expect(r2.filesWritten.length).toBe(0);
				expect(r2.filesUnchanged.length).toBeGreaterThan(0);
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect('applies parent directory modes from sensitivity policy', () =>
		withTempRoot('codegen-test', (root) => {
			const publicDir = `${root}/public`;
			const secretDir = `${root}/secrets`;
			const modeOf = (path: string): number => statSync(path).mode & 0o777;
			const contributions = [
				fakeDecl({
					emitterName: 'public',
					outputPath: 'public/value.ts',
					sensitive: false,
					exports: { value: 'public' },
				}),
				fakeDecl({
					emitterName: 'secret',
					outputPath: 'secrets/value.ts',
					sensitive: true,
					exports: { value: 'secret' },
				}),
			];
			return Effect.gen(function* () {
				yield* runEmitCycle({ contributions });
				expect(modeOf(publicDir)).toBe(0o755);
				expect(modeOf(secretDir)).toBe(0o700);

				chmodSync(secretDir, 0o755);
				yield* runEmitCycle({ contributions });
				expect(modeOf(secretDir)).toBe(0o700);
			}).pipe(Effect.provide(baseLayer(root)));
		}),
	);

	it.effect('emits aggregate app-facing accounts coins packages and services files', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				// Each decl below carries its own `aggregate` contribution
				// matching what the real account/coin/sui/package plugins
				// register. The orchestrator must remain plugin-name-blind.
				const result = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'account/alice',
							outputPath: 'accounts/alice.ts',
							aggregate: {
								bucket: 'accounts.ts',
								project: (e) => e,
							},
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
							aggregate: {
								bucket: 'coins.ts',
								project: (e) => e,
							},
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
							aggregate: {
								bucket: 'services.ts',
								project: (e) => {
									const n = e['suiNetwork'] as {
										readonly rpcUrl: string;
										readonly faucetUrl: string | null;
										readonly graphqlUrl: string | null;
									};
									return {
										sui: {
											rpc: { url: n.rpcUrl },
											faucet: n.faucetUrl === null ? null : { url: n.faucetUrl },
											graphql: n.graphqlUrl === null ? null : { url: n.graphqlUrl },
										},
									};
								},
							},
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
							allowEmitterNameRepetition: true,
							aggregate: {
								bucket: 'packages.ts',
								project: (e) => {
									const b = e['packageBindings'] as { readonly name: string };
									return { [b.name]: b };
								},
							},
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
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect(
		'imports generated package pointer, aggregate, and Move binding modules without sui',
		() =>
			withTempRoot('codegen-test', (root) =>
				Effect.gen(function* () {
					const packageAggregate = {
						bucket: 'packages.ts',
						project: (e: Readonly<Record<string, unknown>>) => {
							const b = e['packageBindings'] as { readonly name: string };
							return { [b.name]: b };
						},
					};
					const result = yield* runEmitCycle({
						contributions: [
							fakeDecl({
								emitterName: 'package',
								outputPath: 'package/hello.ts',
								allowEmitterNameRepetition: true,
								aggregate: packageAggregate,
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
						result.bindings?.filesWritten.some((path) =>
							path.endsWith('/bindings/hello/index.ts'),
						),
					).toBe(true);

					const packageModule = yield* Effect.promise(
						() =>
							import(
								`${pathToFileURL(`${root}/package/hello.ts`).href}?t=${Date.now()}`
							) as Promise<{
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
								allowEmitterNameRepetition: true,
								aggregate: packageAggregate,
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
				}).pipe(Effect.provide(baseLayer(root))),
			),
	);

	it.effect('adds portable return types to generic BCS factory bindings', () =>
		withTempRoot('codegen-test', (root) => {
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
				yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'package',
							outputPath: 'package/hello.ts',
							allowEmitterNameRepetition: true,
							aggregate: {
								bucket: 'packages.ts',
								project: (e) => {
									const b = e['packageBindings'] as { readonly name: string };
									return { [b.name]: b };
								},
							},
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
			}).pipe(Effect.provide(baseLayerWithMove(root, moveLayers)));
		}),
	);
});

// Architectural invariant: the codegen orchestrator service module
// must not name any plugin (ARCHITECTURE.md § "Orchestrator
// boundaries — never names a service"). Aggregate special-casing
// lives in the plugin contributors via `CodegenableDecl.aggregate`.
describe('codegen orchestrator source — plugin-name blindness', () => {
	it('does not reference any plugin name in service.ts', async () => {
		const serviceUrl = new URL('../../../src/orchestrators/codegen/service.ts', import.meta.url);
		const source = await readFile(fileURLToPath(serviceUrl), 'utf8');
		const forbiddenPluginNames = [
			"'sui-network'",
			"'suiNetwork'",
			"'account/",
			"'coin/",
			"'packageBindings'",
		];
		for (const needle of forbiddenPluginNames) {
			expect(source, `service.ts must not mention ${needle}`).not.toContain(needle);
		}
	});
});
