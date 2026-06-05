// TUI surface errors.
//
// Architecture §11 (Renderer): the renderer surface satisfies the
// `Renderer` contract from `contracts/renderer.ts`, which already
// defines `RendererError`. The TUI surface adds NO new error tags of
// its own beyond the contract's two reasons — `mount-failed` and
// `subscription-lost`. Anything that would be a third reason is
// either upstream (lifecycle event from the engine, projected into
// `state.errors[]`) or a programmer-error defect (Effect.die).
//
// This module exists as a single import site for the TUI's error
// constructors so the surface code never reaches across the substrate
// boundary directly when fabricating its typed failures.

import type { RendererError } from '../../contracts/renderer.ts';

/** Construct a `mount-failed` renderer error. */
export const mountFailed = (detail: string): RendererError => ({
	_tag: 'RendererError',
	reason: 'mount-failed',
	detail,
});

// Re-export the shared contract type so callers in this surface only
// need to import from one place.
export type { RendererError };
