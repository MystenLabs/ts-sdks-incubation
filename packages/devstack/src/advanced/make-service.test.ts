// Tests for the `makeService(pluginName, kind, impl)` HOF.
//
// Pins:
//   1. Returned object is the same reference as the input (mutation, not copy).
//   2. `__kind` + `__pluginName` are stamped with the supplied values.
//   3. Pre-existing fields on the impl survive untouched (no clobber).
//   4. The TypeScript surface preserves the impl's type (LayeredTag survives).
//   5. Behavior matches the pre-HOF `Object.assign(impl, {__kind, __pluginName})`
//      shape — identical field key names + values.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeService } from './make-service.js';
import { tag } from './tag.js';

describe('makeService()', () => {
	it('stamps __kind and __pluginName', () => {
		const t = tag('mk-1', Effect.succeed({ ok: true }));
		const stamped = makeService('myplugin', 'service', t);
		expect(stamped.__kind).toBe('service');
		expect(stamped.__pluginName).toBe('myplugin');
	});

	it('returns the same reference (mutating Object.assign)', () => {
		const t = tag('mk-2', Effect.succeed({ ok: true }));
		const stamped = makeService('mk', 'service', t);
		expect(stamped).toBe(t);
	});

	it('preserves pre-existing tag fields (__layer, __layers, key)', () => {
		const t = tag('mk-3', Effect.succeed({ ok: true }));
		const { __layer, __layers, key } = t;
		const stamped = makeService('mk', 'action', t);
		expect(stamped.__layer).toBe(__layer);
		expect(stamped.__layers).toBe(__layers);
		expect(stamped.key).toBe(key);
	});

	it('accepts every TagKind discriminator', () => {
		const kinds = ['service', 'action', 'app', 'account', 'package'] as const;
		for (const k of kinds) {
			const t = tag(`mk-k-${k}`, Effect.succeed({ ok: true }));
			const stamped = makeService('mk', k, t);
			expect(stamped.__kind).toBe(k);
		}
	});

	it('matches the literal `Object.assign(impl, {__kind, __pluginName})` shape', () => {
		// Reference: the pre-HOF shape every migrated site used to inline.
		const t = tag('mk-shape', Effect.succeed({ ok: true }));
		const hofShape = makeService('shape', 'service', t);
		const literalShape = Object.assign(tag('mk-shape-2', Effect.succeed({ ok: true })), {
			__kind: 'service' as const,
			__pluginName: 'shape',
		});
		expect(hofShape.__kind).toBe(literalShape.__kind);
		expect(hofShape.__pluginName).toBe(literalShape.__pluginName);
	});

	it('overwrites existing __kind / __pluginName when called twice (last-wins)', () => {
		// Defensive — same Object.assign last-wins semantic the literal
		// sites had. A second factory call wrapping the same impl would
		// always overwrite; we don't pretend that's an error here.
		const t = tag('mk-twice', Effect.succeed({ ok: true }));
		makeService('first', 'service', t);
		makeService('second', 'action', t);
		expect(t.__kind).toBe('action');
		expect(t.__pluginName).toBe('second');
	});
});
