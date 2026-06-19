// Codegen orchestrator — service-level tests.
//
// Exercises uniqueness validation (path collision + emitter
// collision), the package-emitter exception, and the full cycle
// against the real Node FileSystem with stubbed Move generators.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
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
	CodegenAggregateConflict,
	CodegenEmitterCollision,
	CodegenPathConflict,
} from '../../../src/orchestrators/codegen/errors.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../../src/orchestrators/codegen/paths.ts';
import {
	CodegenOrchestratorService,
	layerCodegenOrchestrator,
	runEmitCycle,
} from '../../../src/orchestrators/codegen/service.ts';

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
	readonly outputLocation?: 'generated' | 'generated-extras';
	readonly aggregateOnly?: boolean;
	readonly allowEmitterNameRepetition?: boolean;
	readonly aggregate?: AggregateContribution;
	readonly exports: { readonly [key: string]: unknown };
}): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: parts.emitterName,
	outputPath: parts.outputPath,
	sensitive: parts.sensitive,
	outputLocation: parts.outputLocation,
	aggregateOnly: parts.aggregateOnly,
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

// Extras tree is a sibling of the runtime tree (mirrors production:
// `generated-extras` lives outside `outputDir`). Tests that assert on
// `generated-extras` artifacts import from `${root}-extras`.
const extrasOf = (root: string): string => `${root}-extras`;

const baseLayer = (root: string) =>
	Layer.mergeAll(stubMoveLayers, layerCodegenPaths, nodePlatformLayer).pipe(
		Layer.provide(
			layerCodegenRoot({ outputDir: root, stackSubdir: null, extrasDir: extrasOf(root) }),
		),
		Layer.provide(nodePlatformLayer),
	);

const baseLayerWithMove = (
	root: string,
	moveLayers: Layer.Layer<MoveCodegenService | MoveSummaryRunnerService>,
) =>
	Layer.mergeAll(moveLayers, layerCodegenPaths, nodePlatformLayer).pipe(
		Layer.provide(
			layerCodegenRoot({ outputDir: root, stackSubdir: null, extrasDir: extrasOf(root) }),
		),
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
						exports: { suiNetwork: { chain: 'sui:localnet', rpcUrl: 'http://x' } },
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

	it.effect(
		'deep-merges sui + packages into one config.ts and routes accounts to generated-extras',
		() =>
			withTempRoot('codegen-test', (root) =>
				Effect.gen(function* () {
					// Each decl below carries its own `aggregate` contribution
					// matching what the real account/coin/sui/package plugins
					// register. The orchestrator must remain plugin-name-blind.
					// sui + package both deep-merge into `config.ts`; account
					// routes to the gitignored `generated-extras` tree.
					const result = yield* runEmitCycle({
						contributions: [
							fakeDecl({
								emitterName: 'account/alice',
								outputPath: 'accounts/alice.ts',
								outputLocation: 'generated-extras',
								aggregateOnly: true,
								aggregate: {
									bucket: 'accounts.ts',
									outputLocation: 'generated-extras',
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
								outputPath: 'config.ts',
								aggregateOnly: true,
								aggregate: {
									bucket: 'config.ts',
									project: (e) => {
										const n = e['__suiNetworkEntry'] as {
											readonly rpc: string;
										};
										return { network: 'localnet', networks: { localnet: n } };
									},
								},
								exports: {
									__suiNetworkEntry: {
										chain: 'sui:localnet',
										mode: 'local',
										rpc: 'http://127.0.0.1:9000',
										faucet: 'http://127.0.0.1:9123',
										graphql: null,
										forkUpstream: null,
									},
								},
							}),
							fakeDecl({
								emitterName: 'package',
								outputPath: 'package/mock-usdc.ts',
								allowEmitterNameRepetition: true,
								aggregateOnly: true,
								aggregate: {
									bucket: 'config.ts',
									project: (e) => {
										const b = e['packageBindings'] as {
											readonly name: string;
											readonly mvrPlaceholder: string;
										};
										return {
											// Mirror the real package projection shape:
											// `{ mvr, packageId }` (per-network ids now live in
											// the injected deployment envelope, not a `byNetwork`
											// sub-key).
											packages: {
												[b.name]: { mvr: b.mvrPlaceholder, packageId: '0x1' },
											},
											// Mirror the real `projectPackageConfig`: each package
											// folds its active-network id into the shared
											// `mvrOverrides` map keyed by its `mvr` placeholder.
											mvrOverrides: { [b.mvrPlaceholder]: '0x1' },
										};
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
						],
					});
					expect(result.filesWritten.some((path) => path.endsWith('/config.ts'))).toBe(true);
					expect(result.filesWritten.some((path) => path.endsWith('/coins.ts'))).toBe(true);
					// The strict app-specific `deployment.ts` is emitted alongside
					// `config-runtime.ts` (config.ts resolves ids at runtime).
					expect(result.filesWritten.some((path) => path.endsWith(`${root}/deployment.ts`))).toBe(
						true,
					);
					expect(
						result.filesWritten.some((path) => path.endsWith(`${root}/config-runtime.ts`)),
					).toBe(true);
					// accounts.ts lands in the extras tree, NOT the runtime tree.
					expect(
						result.filesWritten.some((path) => path.endsWith(`${extrasOf(root)}/accounts.ts`)),
					).toBe(true);
					expect(result.filesWritten.some((path) => path.endsWith(`${root}/accounts.ts`))).toBe(
						false,
					);
					expect(result.bindings?.packagesEmitted).toEqual([]);

					// The committed `config.ts` now opens with
					// `const __deployment = loadDeployment();` — the loud-failing
					// deployment accessor — so importing it requires an injected
					// deployment. Stub `__DEVSTACK_DEPLOYMENT__` (the Vite `define`
					// channel) with the multi-network ENVELOPE for the duration of the
					// imports; restore it after so the global stays clean for sibling
					// tests.
					yield* Effect.acquireRelease(
						Effect.sync(() => {
							(globalThis as Record<string, unknown>)['__DEVSTACK_DEPLOYMENT__'] = {
								defaultNetwork: 'localnet',
								networks: {
									localnet: {
										network: 'localnet',
										rpc: 'http://127.0.0.1:9000',
										local: true,
										packages: { mock_usdc: { id: '0x1' } },
										mvrOverrides: { 'mock-usdc': '0x1' },
									},
								},
								// Dev accounts ride the ENVELOPE (network-agnostic), not the unit.
								accounts: { alice: '0xabc' },
							};
						}),
						() =>
							Effect.sync(() => {
								delete (globalThis as Record<string, unknown>)['__DEVSTACK_DEPLOYMENT__'];
							}),
					);

					const configModule = yield* Effect.promise(
						() =>
							import(`${pathToFileURL(`${root}/config.ts`).href}?t=${Date.now()}`) as Promise<{
								readonly config: {
									readonly network: string;
									readonly defaultNetwork: string;
									readonly networkNames: readonly string[];
									readonly forNetwork: (network: string) => { readonly rpc: string };
									readonly networks: {
										readonly localnet: { readonly rpc: string };
									};
									readonly packages: {
										readonly mock_usdc: {
											readonly packageId: string;
										};
									};
									readonly mvrOverrides: Readonly<Record<string, string>>;
								};
							}>,
					);
					const coinsModule = yield* Effect.promise(
						() =>
							import(`${pathToFileURL(`${root}/coins.ts`).href}?t=${Date.now()}`) as Promise<{
								readonly coins: { readonly mock_usdc: { readonly fullCoinType: string } };
							}>,
					);
					const accountsModule = yield* Effect.promise(
						() =>
							import(
								`${pathToFileURL(`${extrasOf(root)}/accounts.ts`).href}?t=${Date.now()}`
							) as Promise<{
								readonly accounts: { readonly alice: { readonly address: string } };
							}>,
					);
					// sui's `networks.localnet` and the package's `packages.*`
					// coexist in ONE config.ts (deep-merge, not last-write-wins).
					expect(configModule.config.network).toBe('localnet');
					expect(configModule.config.networks.localnet.rpc).toBe('http://127.0.0.1:9000');
					// The static-only DEPLOYMENT envelope accessors are wired off
					// the loaded deployment: default network, the available network
					// names, and the per-network lookup. There is deliberately NO
					// `activeNetwork` — apps resolve per-network data through
					// `config.forNetwork(<dapp-kit-selected network>)` so nothing
					// drifts out of sync with the runtime-selected network.
					expect(configModule.config.defaultNetwork).toBe('localnet');
					expect(configModule.config.networkNames).toEqual(['localnet']);
					expect(configModule.config.forNetwork('localnet').rpc).toBe('http://127.0.0.1:9000');
					expect('activeNetwork' in configModule.config).toBe(false);
					expect(configModule.config.packages.mock_usdc.packageId).toBe('0x1');
					// The package entry no longer carries a `byNetwork` sub-key —
					// per-network ids live in the injected deployment envelope.
					expect('byNetwork' in configModule.config.packages.mock_usdc).toBe(false);
					// Top-level `mvrOverrides` is the active-network name→id map
					// (what the old per-app `mvrOverrides()` helper computed):
					// keyed by the package's `mvr` placeholder, valued by the
					// default-network resolved id. Apps feed it straight into
					// dapp-kit's `mvr.overrides.packages`.
					expect(configModule.config.mvrOverrides).toEqual({ 'mock-usdc': '0x1' });
					expect(configModule.config.mvrOverrides['mock-usdc']).toBe(
						configModule.config.packages.mock_usdc.packageId,
					);
					expect(coinsModule.coins.mock_usdc.fullCoinType).toBe('0x1::mock_usdc::MOCK_USDC');
					expect(accountsModule.accounts.alice.address).toBe('0xabc');
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
						result.bindings?.filesWritten.some((path) => path.endsWith('/bindings/hello/index.ts')),
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

	it.effect('fails fast when two contributors to one bucket disagree on outputLocation', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				const result = yield* runEmitCycle({
					contributions: [
						// First contributor establishes `generated` (non-sensitive).
						fakeDecl({
							emitterName: 'first',
							outputPath: 'first.ts',
							aggregateOnly: true,
							aggregate: {
								bucket: 'config.ts',
								outputLocation: 'generated',
								project: (e) => e,
							},
							exports: { a: { x: 1 } },
						}),
						// Later contributor disagrees: routes to extras +
						// sensitive. MUST be rejected, not silently ignored
						// (would otherwise land the secret in committed tree).
						fakeDecl({
							emitterName: 'second',
							outputPath: 'second.ts',
							aggregateOnly: true,
							aggregate: {
								bucket: 'config.ts',
								outputLocation: 'generated-extras',
								sensitive: true,
								project: (e) => e,
							},
							exports: { b: { y: 2 } },
						}),
					],
				}).pipe(Effect.flip);
				expect(result).toBeInstanceOf(CodegenAggregateConflict);
				if (result instanceof CodegenAggregateConflict) {
					expect(result.bucket).toBe('config.ts');
					expect(result.field).toBe('outputLocation');
					expect(result.established).toBe('generated');
					expect(result.conflicting).toBe('generated-extras');
					expect([...result.emitters]).toEqual(['first', 'second']);
				}
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect('fails fast when two contributors to one bucket disagree on sensitive', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				const result = yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'first',
							outputPath: 'first.ts',
							aggregateOnly: true,
							aggregate: {
								bucket: 'secrets.ts',
								sensitive: false,
								project: (e) => e,
							},
							exports: { a: { x: 1 } },
						}),
						fakeDecl({
							emitterName: 'second',
							outputPath: 'second.ts',
							aggregateOnly: true,
							aggregate: {
								bucket: 'secrets.ts',
								sensitive: true,
								project: (e) => e,
							},
							exports: { b: { y: 2 } },
						}),
					],
				}).pipe(Effect.flip);
				expect(result).toBeInstanceOf(CodegenAggregateConflict);
				if (result instanceof CodegenAggregateConflict) {
					expect(result.bucket).toBe('secrets.ts');
					expect(result.field).toBe('sensitive');
					expect(result.established).toBe('false');
					expect(result.conflicting).toBe('true');
				}
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect('emits an explicit gitignore line for a sensitive aggregate routed to generated', () =>
		withTempRoot('codegen-test', (root) =>
			Effect.gen(function* () {
				yield* runEmitCycle({
					contributions: [
						// Sensitive aggregate-only contributor routed to the
						// runtime `generated` tree. Its standalone file is
						// skipped (aggregateOnly), so the standalone sensitive
						// scan never sees it — only the synthesized aggregate
						// path makes it into `.gitignore`.
						fakeDecl({
							emitterName: 'secret-agg',
							outputPath: 'secret-src.ts',
							aggregateOnly: true,
							aggregate: {
								bucket: 'secrets.ts',
								outputLocation: 'generated',
								sensitive: true,
								project: (e) => e,
							},
							exports: { token: { value: 'shhh' } },
						}),
					],
				});
				const gitignore = yield* Effect.promise(() => readFile(`${root}/.gitignore`, 'utf8'));
				// The blanket `*` is always present; assert the EXPLICIT
				// sensitive re-ignore line for the synthesized aggregate is
				// emitted too (under the sensitive-files documentation block).
				expect(gitignore).toContain(
					'# sensitive files — never commit even if you override the `*` above.',
				);
				const lines = gitignore.split('\n');
				expect(lines).toContain('secrets.ts');
			}).pipe(Effect.provide(baseLayer(root))),
		),
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

describe('codegen.emitExtras', () => {
	it.effect('flushes ONLY the generated-extras decls, leaving the runtime tree untouched', () =>
		withTempRoot('codegen-extras-test', (root) =>
			Effect.scoped(
				Effect.gen(function* () {
					const codegen = yield* CodegenOrchestratorService;
					// A dev-wallet-shaped decl routed to generated-extras (sensitive,
					// like the real one) plus an account-shaped aggregate into
					// `accounts.ts` (also generated-extras).
					yield* codegen.registerContribution(
						'wallet',
						fakeDecl({
							emitterName: 'dapp-kit-config',
							outputPath: 'dev-wallet.ts',
							outputLocation: 'generated-extras',
							sensitive: true,
							exports: { devWallet: { url: 'http://127.0.0.1:9999' } },
						}),
					);
					yield* codegen.registerContribution(
						'account',
						fakeDecl({
							emitterName: 'account/alice',
							outputPath: 'accounts/alice.ts',
							outputLocation: 'generated-extras',
							aggregateOnly: true,
							aggregate: {
								kind: 'account',
								bucket: 'accounts.ts',
								outputLocation: 'generated-extras',
								project: (exported) => exported,
							},
							exports: { alice: { address: '0xa11ce' } },
						}),
					);
					// A `generated`-located decl that emitExtras MUST skip — it
					// belongs to the committed `src/generated` tree written only by
					// the stack-free `codegen` verb.
					yield* codegen.registerContribution(
						'sui',
						fakeDecl({
							emitterName: 'config',
							outputPath: 'config.ts',
							outputLocation: 'generated',
							exports: { network: 'localnet' },
						}),
					);

					const result = yield* codegen.emitExtras();

					// dev-wallet.ts + accounts.ts land in the extras tree...
					const extras = extrasOf(root);
					const walletPath = `${extras}/dev-wallet.ts`;
					const accountsPath = `${extras}/accounts.ts`;
					expect(result.filesWritten).toContain(walletPath);
					expect(result.filesWritten).toContain(accountsPath);
					const walletSource = yield* Effect.promise(() => readFile(walletPath, 'utf8'));
					expect(walletSource).toContain('devWallet');
					// ...the sensitive wallet file is 0o600.
					expect(statSync(walletPath).mode & 0o777).toBe(0o600);
					const accountsSource = yield* Effect.promise(() => readFile(accountsPath, 'utf8'));
					expect(accountsSource).toContain('0xa11ce');

					// The `generated` decl is NEVER written by emitExtras.
					expect(existsSync(`${root}/config.ts`)).toBe(false);
					expect(result.filesWritten.some((p) => p === `${root}/config.ts`)).toBe(false);
				}),
			).pipe(Effect.provide(baseLayer(root)), Effect.provide(layerCodegenOrchestrator)),
		),
	);

	it.effect('is a no-op (empty result) when nothing is routed to generated-extras', () =>
		withTempRoot('codegen-extras-empty', (root) =>
			Effect.scoped(
				Effect.gen(function* () {
					const codegen = yield* CodegenOrchestratorService;
					yield* codegen.registerContribution(
						'sui',
						fakeDecl({
							emitterName: 'config',
							outputPath: 'config.ts',
							outputLocation: 'generated',
							exports: { network: 'localnet' },
						}),
					);
					const result = yield* codegen.emitExtras();
					expect(result.filesWritten).toEqual([]);
					expect(result.filesChmod).toEqual([]);
					expect(existsSync(extrasOf(root))).toBe(false);
				}),
			).pipe(Effect.provide(baseLayer(root)), Effect.provide(layerCodegenOrchestrator)),
		),
	);
});

describe('codegen.emitBindings', () => {
	// The dev-`up` invariant: `emitBindings` regenerates the committed tree from
	// the caller's STATIC (id-free) contributions and IGNORES the live
	// registered ref — otherwise it bakes resolved on-chain ids into the
	// committed `config.ts`, breaking a fresh clone (and any other stack reading
	// the tree). A regression that reverts to reading `contributionsRef` would
	// pass every other test; this one fails it.
	it.effect('emits from the PASSED static contributions, never the live registered ref', () =>
		withTempRoot('codegen-emitbindings', (root) =>
			Effect.scoped(
				Effect.gen(function* () {
					const codegen = yield* CodegenOrchestratorService;

					// A LIVE `config.ts` contribution registered into the ref — shaped
					// like a boot-time package config that BAKES a real on-chain id.
					yield* codegen.registerContribution(
						'package',
						fakeDecl({
							emitterName: 'config',
							outputPath: 'config.ts',
							outputLocation: 'generated',
							exports: { liveBakedId: '0xliveBAKEDid' },
						}),
					);

					// `emitBindings` is handed the STATIC (id-free) decls — the same
					// the stack-free `codegen` verb derives. config.ts must come from
					// THESE, not the registered live ref above.
					const result = yield* codegen.emitBindings([
						fakeDecl({
							emitterName: 'config',
							outputPath: 'config.ts',
							outputLocation: 'generated',
							exports: { idFreeResolver: 'RESOLVE_ID_PLACEHOLDER' },
						}),
					]);

					const configPath = `${root}/config.ts`;
					expect(result.filesWritten).toContain(configPath);
					const source = yield* Effect.promise(() => readFile(configPath, 'utf8'));
					// The id-free static value is emitted...
					expect(source).toContain('RESOLVE_ID_PLACEHOLDER');
					// ...and the live baked id NEVER leaks into the committed tree.
					expect(source).not.toContain('0xliveBAKEDid');
				}),
			).pipe(Effect.provide(baseLayer(root)), Effect.provide(layerCodegenOrchestrator)),
		),
	);

	it.effect('is a no-op (empty result) when handed no contributions', () =>
		withTempRoot('codegen-emitbindings-empty', (root) =>
			Effect.scoped(
				Effect.gen(function* () {
					const codegen = yield* CodegenOrchestratorService;
					const result = yield* codegen.emitBindings([]);
					expect(result.filesWritten).toEqual([]);
					expect(existsSync(`${root}/config.ts`)).toBe(false);
				}),
			).pipe(Effect.provide(baseLayer(root)), Effect.provide(layerCodegenOrchestrator)),
		),
	);
});

describe('codegen.assembleDeployment — active-network agreement', () => {
	// A sui-like config.ts contribution: the binding emits `network: 'localnet'`
	// and a `networks` map keyed by 'localnet' for EVERY identity mode (mirrors
	// plugins/sui/codegen.ts hard-coding LOCAL_NETWORK_NAME). The deployment's
	// active `network` field MUST be a key present in `networks` — the committed
	// runtime resolver does `resolveNetworks()[network]`.
	const suiLikeDecl = (): CodegenableDecl<string> =>
		fakeDecl({
			emitterName: 'sui-network',
			outputPath: 'config.ts',
			outputLocation: 'generated',
			aggregateOnly: true,
			aggregate: {
				kind: 'sui-network',
				bucket: 'config.ts',
				outputLocation: 'generated',
				// Project the emitted `network` + `networks` straight into the
				// config.ts bucket (what the real sui projection does).
				project: (exported) => ({
					network: exported.network,
					networks: exported.networks,
				}),
			},
			// Bound by the binding to LOCAL_NETWORK_NAME regardless of mode.
			exports: {
				network: 'localnet',
				networks: { localnet: { rpc: 'http://127.0.0.1:9000', chainId: 'abc' } },
			},
		});

	it.effect(
		'a NON-localnet identity yields a network field that EXISTS in networks (no divergence)',
		() =>
			withTempRoot('codegen-idconfig-net', (root) =>
				Effect.scoped(
					Effect.gen(function* () {
						const codegen = yield* CodegenOrchestratorService;
						yield* codegen.registerContribution('sui', suiLikeDecl());
						// Boot for a fork: identity network = 'testnet-fork', but the
						// sui binding still keys `networks` by 'localnet'. Old behavior
						// stamped network: 'testnet-fork' (absent from networks) →
						// `resolveNetworks()['testnet-fork']` is undefined → throws +
						// dev-wallet injection reads undefined.rpc. The fix derives the
						// active network from the bucket so they AGREE.
						const deployment = yield* codegen.assembleDeployment('testnet-fork');
						// The envelope's default network MUST be a key present in
						// `networks`, and each unit's `network` field agrees with its key.
						expect(Object.keys(deployment.networks)).toContain(deployment.defaultNetwork);
						const unit = deployment.networks[deployment.defaultNetwork]!;
						expect(unit.network).toBe(deployment.defaultNetwork);
						// And it is the key the binding emitted ('localnet').
						expect(deployment.defaultNetwork).toBe('localnet');
					}),
				).pipe(Effect.provide(baseLayer(root)), Effect.provide(layerCodegenOrchestrator)),
			),
	);
});

// Regression: an extras-only emit (boot's `emitExtras`) writes solely into
// `extrasDir` (under the already-gitignored `.devstack/` root), so it must NOT
// write a managed `.gitignore` at the committed `<outputDir>/.gitignore`. At
// boot `outputDir` is only a stand-in — clobbering its tracked `.gitignore`
// with the ignore-all policy on every `devstack up` would break `tsc`/`vite
// build` on a fresh clone (the committed bindings would become untracked).
describe('codegen extras emit — committed .gitignore is never clobbered', () => {
	it.effect('an extras-only emit leaves the committed tree’s TRACKED .gitignore untouched', () =>
		withTempRoot('codegen-extras-gitignore', (root) =>
			Effect.gen(function* () {
				const committedIgnore = `${root}/.gitignore`;

				// 1. A committed emit lays down the TRACKED policy at
				//    `<outputDir>/.gitignore`, as the stack-free `codegen` verb does.
				yield* runEmitCycle({
					contributions: [
						fakeDecl({ emitterName: 'pkg', outputPath: 'bindings/pkg.ts', exports: { ID: '0x1' } }),
					],
					trackTree: true,
				});
				expect(existsSync(committedIgnore)).toBe(true);
				const tracked = readFileSync(committedIgnore, 'utf8');
				expect(tracked).toContain('track the whole committed projection tree');

				// 2. An extras-only emit (only `generated-extras` decls) must NOT
				//    touch the committed `.gitignore` — extras need no managed
				//    ignore (they live under the gitignored `.devstack/` root).
				yield* runEmitCycle({
					contributions: [
						fakeDecl({
							emitterName: 'account/alice',
							outputPath: 'accounts/alice.ts',
							outputLocation: 'generated-extras',
							exports: { alice: { name: 'alice', address: '0xabc' } },
						}),
					],
					trackTree: false,
				});

				// committed tree's .gitignore is byte-for-byte unchanged (still TRACK).
				expect(readFileSync(committedIgnore, 'utf8')).toBe(tracked);
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);
});
