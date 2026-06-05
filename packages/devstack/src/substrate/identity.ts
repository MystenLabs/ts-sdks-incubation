// Stack identity tuple. Validated once at boot; threaded through
// Context for the lifetime of the stack.

import type { AppName, StackName } from './brand.ts';

/** Closed identity tuple. Architecture § Stack data model. The substrate
 *  is name-blind: it knows nothing about chains or network modes. */
export interface Identity {
	readonly app: AppName;
	readonly stack: StackName;
	/** Opaque identity label — a substrate-blind plain string the caller
	 *  supplies once at boot, threaded through Context as a generic
	 *  correlation/display label (supervisor labels, span attributes,
	 *  snapshot provenance meta). The substrate NEVER parses it or branches
	 *  on its value; it carries no network/mode semantics here. Callers
	 *  (CLI / `runStack`) happen to set it to a resolved chain string, but
	 *  that is a producer concern, not a substrate primitive. */
	readonly chain: string;
}
