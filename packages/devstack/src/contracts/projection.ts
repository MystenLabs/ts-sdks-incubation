import type { EngineEvent } from '../substrate/events.ts';

export type ProjectionEvent =
	| Extract<EngineEvent, { readonly tag: 'account.updated' }>
	| Extract<EngineEvent, { readonly tag: 'package.updated' }>;

export interface ProjectionDecl {
	readonly kind: 'projection';
	readonly event: ProjectionEvent;
}
