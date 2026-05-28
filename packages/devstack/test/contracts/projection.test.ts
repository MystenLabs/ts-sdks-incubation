// Structural pins for the `ProjectionDecl` capability contract.
//
// Plugins emit a `projection.updated` event nested inside a `ProjectionDecl`
// envelope. The substrate stays name-blind: the kind→decoder mapping is
// owned by the consuming orchestrator (the projection reducer). This file
// pins the discriminated `kind: 'projection'`, the required `event` slot,
// and the projection-event tag literal.

import { describe, expect, it } from 'vitest';

import { projection } from '../../src/api/define-capabilities.ts';
import type { ProjectionDecl, ProjectionEvent } from '../../src/contracts/projection.ts';

describe('contracts/projection — structural pins', () => {
	it('discriminated-union `kind` is the literal `"projection"`', () => {
		const decl: ProjectionDecl = {
			kind: 'projection',
			event: {
				tag: 'projection.updated',
				kind: 'demo',
				key: 'demo:1',
				payload: { ok: true },
				at: 0,
			},
		};
		const tagged: 'projection' = decl.kind;
		expect(tagged).toBe('projection');
	});

	it('event.tag must be the literal `"projection.updated"`', () => {
		const event: ProjectionEvent = {
			tag: 'projection.updated',
			kind: 'demo',
			key: 'demo:1',
			payload: null,
			at: 0,
		};
		const tag: 'projection.updated' = event.tag;
		expect(tag).toBe('projection.updated');

		const _bad: ProjectionEvent = {
			// @ts-expect-error -- only `'projection.updated'` allowed.
			tag: 'projection.refreshed',
			kind: 'demo',
			key: 'demo:1',
			payload: null,
			at: 0,
		};
		void _bad;
	});

	it('rejects a literal missing the `event` slot', () => {
		// @ts-expect-error -- `event` is required.
		const _bad: ProjectionDecl = { kind: 'projection' };
		void _bad;
	});

	it('rejects a `ProjectionEvent` missing required fields', () => {
		// @ts-expect-error -- `kind`/`key`/`payload`/`at` are required.
		const _bad: ProjectionEvent = { tag: 'projection.updated' };
		void _bad;
	});

	it('`define-capabilities.ts` helper round-trips and adds `kind`', () => {
		const decl = projection({
			event: {
				tag: 'projection.updated',
				kind: 'account.balance',
				key: 'account:alice',
				payload: { sui: '1000' },
				at: 123,
			},
		});
		expect(decl.kind).toBe('projection');
		expect(decl.event.tag).toBe('projection.updated');
		expect(decl.event.kind).toBe('account.balance');
		expect(decl.event.at).toBe(123);
	});
});
