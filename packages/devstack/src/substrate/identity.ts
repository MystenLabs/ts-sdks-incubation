// Stack identity tuple. Validated once at boot; threaded through
// Context for the lifetime of the stack.

import type { AppName, ChainId, StackName } from './brand.ts';

/** Closed identity triple. Architecture § Stack data model. */
export interface Identity {
	readonly app: AppName;
	readonly stack: StackName;
	/** Resolved chain identifier from NetworkResolver. */
	readonly chain: ChainId;
}
