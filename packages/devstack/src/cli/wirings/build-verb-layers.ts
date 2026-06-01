// Shared substrate + orchestrator Layer composition for verb wirings.
//
// The CLI verbs that boot a substrate (`up`, `apply --direct`, snapshot
// capture --direct) all build the same composition:
//   - `layerProductionOrchestrators({ codegen })` on top of
//   - `buildSubstrateLayers(identity, runtimeRoot)`.
//
// Extracted here so each wiring file references one helper instead of
// rebuilding the composition inline (formerly ~5 sites in `main.ts`).

import { Layer } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import { buildSubstrateLayers } from '../../orchestrators/run.ts';
import { layerProductionOrchestrators } from '../../orchestrators/runtime-composition.ts';
import { resolveCodegenOutput } from '../../orchestrators/codegen/output-location.ts';
import type { SupervisedStack } from '../../substrate/runtime/index.ts';

/** Compose substrate + orchestrator Layers for a verb that knows its
 *  stack-config (i.e. has a `loaded` config and can pass codegen
 *  options). Use `buildDirectSnapshotLayers` when the verb does NOT
 *  load a config (e.g. restore/delete/wipe).
 *
 *  Resolves the per-stack codegen output location HERE — the one boot
 *  seam where both the primary stack (`stack.options.stackName`) and the
 *  EFFECTIVE stack (`String(identity.stack)`, already run through the
 *  explicit-`--stack` > `config.stackName` > inferred precedence ladder
 *  by `resolvedIdentityForStack`/`identityValueFor` upstream) are in
 *  scope. The primary run emits into `src/generated/`; a secondary run
 *  (concurrent `--stack e2e`/etc.) emits into
 *  `.devstack/stacks/<stack>/generated/` so the two never clobber. The
 *  resolved literal `outputDir`/`stackSubdir` flow into
 *  `layerProductionOrchestrators` unchanged — `paths.ts` keeps consuming
 *  a literal, minimal blast radius. */
export const buildVerbLayers = (params: {
	readonly identity: Identity;
	readonly stack: SupervisedStack;
	readonly appRoot: string;
	readonly runtimeRoot: string;
}) => {
	const codegenOutput = resolveCodegenOutput({
		appRoot: params.appRoot,
		effectiveStack: String(params.identity.stack),
		primaryStack: params.stack.options.stackName,
		explicitOutputDir: params.stack.options.codegen?.outputDir,
		explicitStackSubdir: params.stack.options.codegen?.stackSubdir ?? null,
	});
	return layerProductionOrchestrators({
		codegen: {
			appRoot: params.appRoot,
			outputDir: codegenOutput.outputDir,
			stackSubdir: codegenOutput.stackSubdir,
		},
	}).pipe(Layer.provideMerge(buildSubstrateLayers(params.identity, params.runtimeRoot)));
};

/** Substrate + (default-codegen) orchestrator Layers for verbs that
 *  don't load a config. */
export const buildDirectSnapshotLayers = (params: {
	readonly identity: Identity;
	readonly runtimeRoot: string;
}) =>
	layerProductionOrchestrators().pipe(
		Layer.provideMerge(buildSubstrateLayers(params.identity, params.runtimeRoot)),
	);
