import type { EngineEvent } from '../substrate/events.ts';

/** The single name-blind projection event variant. Plugin authors
 *  build a `ProjectionDecl` carrying one of these; the substrate
 *  routes it to the projection orchestrator, which decodes the
 *  opaque `payload` per `kind`. */
export type ProjectionEvent = Extract<EngineEvent, { readonly tag: 'projection.updated' }>;

export interface ProjectionDecl {
	readonly kind: 'projection';
	readonly event: ProjectionEvent;
}
