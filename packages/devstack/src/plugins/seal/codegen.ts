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

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SealKeyServerEntry } from './registry-publish.ts';

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

/** Build the Codegenable contribution for a seal instance. */
export const makeSealCodegenable = (
	bindings: SealBindings,
): CodegenableDecl<'seal-key-server'> => ({
	kind: 'codegenable',
	emitterName: 'seal-key-server',
	outputPath: `seal/${bindings.name}.ts`,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('sealBindings', bindings satisfies SealBindings);
			return ctx.done();
		}),
});
