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
//   - The emitter name `'seal-key-server'` is the literal
//     `EmittedFor<Caps, 'seal-key-server'>` key downstream consumers
//     use. We pin it once here.

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
	/** Mode marker so the bindings file knows whether to surface the
	 *  admin rotate Effect-construction shim (distilled-doc invariant
	 *  #15 — only local-keygen mode produces a manager). */
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
}

// ---------------------------------------------------------------------------
// Decl builder
// ---------------------------------------------------------------------------

/** Build the Codegenable contribution for a seal instance. */
export const makeSealCodegenable = (
	bindings: SealBindings,
): CodegenableDecl<SealBindings, 'seal-key-server'> => ({
	kind: 'codegenable',
	emitterName: 'seal-key-server',
	outputPath: `seal/${bindings.name}.ts`,
	emit: () =>
		Effect.sync(() => ({
			sealBindings: bindings satisfies SealBindings,
		})),
});
