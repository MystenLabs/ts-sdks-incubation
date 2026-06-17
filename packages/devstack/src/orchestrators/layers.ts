// Shared substrate + orchestrator Layer composition for stack boot seams.
//
// The seams that boot a substrate (CLI `up`, `apply --direct`, snapshot
// capture --direct; and `api/run-stack.ts`) all build the same composition:
//   - `layerProductionOrchestrators({ codegen })` on top of
//   - `buildSubstrateLayers(identity, runtimeRoot)`.
//
// One helper each seam references, instead of rebuilding the composition
// inline at every call site. Lives in `orchestrators/` so BOTH `api/` and
// `cli/` can import it by going *down* the layering (neither can import the
// other). This module imports only from `orchestrators/boot.ts` and
// `substrate/` — never from `api/` or `cli/`, so there is no import cycle.

import { Layer } from 'effect';

import type { Identity } from '../substrate/identity.ts';
import {
	buildSubstrateLayers,
	layerProductionOrchestrators,
	resolveProductionCodegenOptions,
} from './boot.ts';
import type { SupervisedStack } from '../substrate/runtime/index.ts';

/** Compose substrate + orchestrator Layers for a verb that knows its
 *  stack-config (i.e. has a `loaded` config and can pass codegen
 *  options). Use `buildDirectSnapshotLayers` when the verb does NOT
 *  load a config (e.g. restore/delete/wipe).
 *
 *  Resolves the per-stack LIVE codegen output location HERE — the one
 *  boot seam where the EFFECTIVE stack (`String(identity.stack)`, already
 *  run through the explicit-`--stack` > `config.stackName` > inferred
 *  precedence ladder by `resolvedIdentityForStack`/`identityValueFor`
 *  upstream) is in scope. EVERY live run emits into
 *  `.devstack/stacks/<stack>/generated/` (gitignored) so the id-bearing
 *  tree never lands in committed source and two stacks never clobber; the
 *  committed `src/generated` tree is owned by the stack-free `codegen`
 *  verb. The resolved literal `outputDir`/`stackSubdir` flow into
 *  `layerProductionOrchestrators` unchanged — `paths.ts` keeps consuming
 *  a literal, minimal blast radius. */
export const buildVerbLayers = (params: {
	readonly identity: Identity;
	readonly stack: SupervisedStack;
	readonly appRoot: string;
	readonly runtimeRoot: string;
}) =>
	layerProductionOrchestrators({
		codegen: resolveProductionCodegenOptions({
			appRoot: params.appRoot,
			effectiveStack: String(params.identity.stack),
			codegen: params.stack.options.codegen,
		}),
	}).pipe(Layer.provideMerge(buildSubstrateLayers(params.identity, params.runtimeRoot)));

/** Substrate + (default-codegen) orchestrator Layers for verbs that
 *  don't load a config. */
export const buildDirectSnapshotLayers = (params: {
	readonly identity: Identity;
	readonly runtimeRoot: string;
}) =>
	layerProductionOrchestrators().pipe(
		Layer.provideMerge(buildSubstrateLayers(params.identity, params.runtimeRoot)),
	);
