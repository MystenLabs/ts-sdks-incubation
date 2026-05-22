// Minimal object-form stack.
//
// Compile-only smoke test for `defineDevstack` + a single trivial leaf
// plugin.

import { Effect } from 'effect';

import { defineDevstack, definePlugin, resource } from '../../../src/index.ts';

const keyvalResource = resource<'keyval', { readonly url: string }>('keyval');

const keyval = () =>
	definePlugin({
		id: keyvalResource.id,
		role: 'service',
		start: () => Effect.succeed({ url: 'http://127.0.0.1:6379' } as const),
	});

export const stack = defineDevstack({ members: [keyval()], stackName: 'minimal-keyval' });
