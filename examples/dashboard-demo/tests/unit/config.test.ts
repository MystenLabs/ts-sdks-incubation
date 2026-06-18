// Unit test — pure config composition, no devstack, no Docker. Runs under
// `pnpm test`. Importing the config runs `defineDevstack`'s expansion +
// provider validation, so this fails fast if the stack is ever edited into
// a malformed shape (duplicate/missing providers throw at import).

import { describe, expect, it } from 'vitest';

import stack from '../../devstack.config.ts';

describe('dashboard-demo config', () => {
	it('composes a stack named dashboard-demo', () => {
		expect(stack.options.stackName).toBe('dashboard-demo');
	});
});
