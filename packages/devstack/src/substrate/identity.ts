// Stack identity tuple. Validated once at boot; threaded through
// Context for the lifetime of the stack.

import type { AppName, ChainId, StackName } from './brand.ts';

/** Closed identity triple. Architecture § Stack data model. */
export interface Identity {
	readonly app: AppName;
	readonly stack: StackName;
	/** Resolved chain identifier — threaded through Context from the
	 *  Sui plugin's resolved mode + `DevstackOptions.network`. */
	readonly chain: ChainId;
}
