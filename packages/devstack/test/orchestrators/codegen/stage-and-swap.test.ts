// Codegen cycle-level stage-and-swap atomicity tests.
//
// Regression for opportunities-backlog #8: prior to the fix,
// `runEmitCycle` wrote each generated file directly into the
// user-visible output dir. A failing emitter mid-cycle left the
// directory half-rewritten. The fix wraps the whole cycle in
// substrate `stageAndSwap` — these tests pin the rollback contract.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import type { CodegenableDecl, CodegenEmitContext } from '../../../src/contracts/codegenable.ts';

import {
	MoveCodegenService,
	MoveSummaryRunnerService,
	stubMoveCodegen,
	stubMoveSummaryRunner,
} from '../../../src/orchestrators/codegen/bindings.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../../src/orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../../src/orchestrators/codegen/service.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'codegen-swap-'));

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
			{ relPath: `${input.packageName}/index.ts`, content: `export const ID = "x";\n` },
		]),
	),
);

const nodePlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const baseLayer = (root: string) =>
	Layer.mergeAll(stubMoveLayers, layerCodegenPaths, nodePlatformLayer).pipe(
		Layer.provide(layerCodegenRoot({ outputDir: root, stackSubdir: null })),
		Layer.provide(nodePlatformLayer),
	);

const writeExports = (
	ctx: CodegenEmitContext,
	exports: { readonly [key: string]: unknown },
): void => {
	for (const [key, value] of Object.entries(exports)) ctx.exportConst(key, value);
};

const successfulDecl = (parts: {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly exports: { readonly [key: string]: unknown };
}): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: parts.emitterName,
	outputPath: parts.outputPath,
	emit: (ctx) =>
		Effect.sync(() => {
			writeExports(ctx, parts.exports);
			return ctx.done();
		}),
});

const failingDecl = (parts: {
	readonly emitterName: string;
	readonly outputPath: string;
}): CodegenableDecl<string> => ({
	kind: 'codegenable',
	emitterName: parts.emitterName,
	outputPath: parts.outputPath,
	emit: () => Effect.die(new Error('emitter blew up')),
});

describe('codegen.runEmitCycle — cycle-level stage-and-swap', () => {
	it.effect('failing mid-cycle emitter leaves the previous output dir untouched', () => {
		const root = freshRoot();
		return Effect.gen(function* () {
			// 1. First cycle establishes a known-good output tree.
			yield* runEmitCycle({
				contributions: [
					successfulDecl({
						emitterName: 'sui-network',
						outputPath: 'sui/network.ts',
						exports: { suiNetwork: { chain: 'sui:local', rpcUrl: 'http://baseline' } },
					}),
				],
			});

			const networkFile = join(root, 'sui/network.ts');
			expect(existsSync(networkFile)).toBe(true);
			const baselineContent = readFileSync(networkFile, 'utf8');
			expect(baselineContent).toContain('baseline');
			const baselineListing = readdirSync(root).sort();

			// 2. Second cycle's third emitter fails. Mid-cycle failure
			//    must not corrupt the user-visible tree.
			const result = yield* Effect.exit(
				runEmitCycle({
					contributions: [
						successfulDecl({
							emitterName: 'aaa-first',
							outputPath: 'aaa-first.ts',
							exports: { v: 'NEW' },
						}),
						successfulDecl({
							emitterName: 'sui-network',
							outputPath: 'sui/network.ts',
							exports: {
								suiNetwork: { chain: 'sui:local', rpcUrl: 'http://OVERWRITE-ATTEMPT' },
							},
						}),
						failingDecl({
							emitterName: 'zzz-fails',
							outputPath: 'zzz-fails.ts',
						}),
					],
				}),
			);

			expect(Exit.isFailure(result)).toBe(true);

			// 3. The baseline file is byte-for-byte unchanged.
			expect(existsSync(networkFile)).toBe(true);
			expect(readFileSync(networkFile, 'utf8')).toBe(baselineContent);

			// 4. The new-this-cycle file did NOT leak into the output dir.
			expect(existsSync(join(root, 'aaa-first.ts'))).toBe(false);

			// 5. The failing file did NOT leak either.
			expect(existsSync(join(root, 'zzz-fails.ts'))).toBe(false);

			// 6. Top-level listing is identical to the baseline (no
			//    staging/backup sibling left behind under the output dir
			//    — they live as parent-dir siblings, see below).
			expect(readdirSync(root).sort()).toEqual(baselineListing);
		}).pipe(
			Effect.provide(baseLayer(root)),
			Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
		);
	});

	it.effect('successful cycle leaves no staging/backup siblings', () => {
		// The staging and backup directories are siblings of the output
		// dir (same filesystem requirement). After a successful cycle,
		// both must be cleaned up so the parent dir stays tidy and
		// concurrent cycles do not collide on stale state.
		const parent = freshRoot();
		const outputDir = join(parent, 'generated');
		mkdirSync(outputDir, { recursive: true });
		return Effect.gen(function* () {
			yield* runEmitCycle({
				contributions: [
					successfulDecl({
						emitterName: 'sui-network',
						outputPath: 'sui/network.ts',
						exports: { suiNetwork: { chain: 'sui:local', rpcUrl: 'http://x' } },
					}),
				],
			});

			const siblings = readdirSync(parent);
			expect(siblings).toContain('generated');
			for (const name of siblings) {
				expect(name).not.toMatch(/^generated\.(staging|bak)\./);
			}
		}).pipe(
			Effect.provide(baseLayer(outputDir)),
			Effect.ensuring(Effect.sync(() => rmSync(parent, { recursive: true, force: true }))),
		);
	});

	it.effect('first-ever cycle (no prior target) creates the output dir atomically', () => {
		// No pre-existing output dir → stage-and-swap still works
		// (the `targetExists` branch in service.ts is skipped) and
		// the freshly created tree appears in one atomic rename.
		const parent = freshRoot();
		const outputDir = join(parent, 'never-existed');
		return Effect.gen(function* () {
			expect(existsSync(outputDir)).toBe(false);
			yield* runEmitCycle({
				contributions: [
					successfulDecl({
						emitterName: 'sui-network',
						outputPath: 'sui/network.ts',
						exports: { suiNetwork: { chain: 'sui:local', rpcUrl: 'http://fresh' } },
					}),
				],
			});
			expect(existsSync(join(outputDir, 'sui/network.ts'))).toBe(true);
		}).pipe(
			Effect.provide(baseLayer(outputDir)),
			Effect.ensuring(Effect.sync(() => rmSync(parent, { recursive: true, force: true }))),
		);
	});
});
