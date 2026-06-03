// Seal plugin — Codegenable contribution.
//
// Distilled-doc §"Outputs": the seal plugin contributes ONE codegen
// emit shape — the `seal-key-server` config the user-facing
// bindings consume to construct a `SealClient`. The orchestrator
// reads this contribution + every other plugin's; the heavy
// codegen substrate (file writing, type-export grouping) lives in
// the codegen orchestrator (architecture §6).
//
// Tag id discipline:
//
//   - The emitter name `'seal-key-server'` is pinned here so the
//     generated output and orchestrator attribution stay stable.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SealKeyServerEntry } from './registry-publish.ts';

import { defineSimpleConstExport } from '../internal/codegen-helpers.ts';

// ---------------------------------------------------------------------------
// Bindings shape
// ---------------------------------------------------------------------------

/** Codegen-emitted shape for seal. Mirrors the read-side resolved
 *  value (sans the per-instance defaults like `weight`). The
 *  bindings emitter writes a TypeScript file exporting these. */
export interface SealBindings {
	readonly name: string;
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
	/** Mode marker for consumers that branch between local-keygen and
	 *  known-deployment surfaces. */
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
}

// ---------------------------------------------------------------------------
// Decl builder
// ---------------------------------------------------------------------------

/** Build the Codegenable contribution for a seal instance.
 *
 *  Name-keyed sibling aggregate (mirrors `coin/codegen.ts`): every
 *  seal instance folds into a single `generated/seal.ts` exporting
 *  `export const seal = { <name>: SealBindings, ... }`. Consumers read
 *  `seal.<name>`. `aggregateOnly` — no standalone per-instance file. */
export const makeSealCodegenable = (
	bindings: SealBindings,
): CodegenableDecl<`seal/${string}`> =>
	defineSimpleConstExport({
		emitterName: `seal/${bindings.name}` as `seal/${string}`,
		outputPath: `seal/${bindings.name}.ts`,
		exportName: bindings.name,
		value: bindings,
		aggregateOnly: true,
		aggregate: {
			kind: 'seal',
			bucket: 'seal.ts',
			// This decl's exported map keys by instance name — the
			// aggregate's merge key.
			project: (exported) => exported,
		},
	});
