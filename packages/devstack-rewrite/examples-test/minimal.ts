// Minimal flat-variadic stack.
//
// Compile-only smoke test for `defineDevstack` + a single trivial leaf
// plugin. Five lines of stack code; everything else is the import.

import { defineDevstack } from '../src/index.ts';
import { keyval } from '../src/samples/trivial-leaf-plugin.ts';

export const stack = defineDevstack(keyval(), { stackName: 'minimal-keyval' });
