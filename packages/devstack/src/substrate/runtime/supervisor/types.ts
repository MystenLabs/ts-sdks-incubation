// Public Stack-like surface the supervisor reads.
//
// The full `Stack<Members>` shape lives in `api/define-devstack.ts`
// and carries type-level provenance — at the runtime boundary the
// supervisor only needs the erased plugin list + options.

import type { AnyPlugin } from '../../plugin.ts';
import type { DevstackOptions } from '../../options.ts';

/** Minimum surface the supervisor reads off a `Stack`. */
export interface SupervisedStack {
	readonly _tag: 'Stack';
	readonly members: ReadonlyArray<AnyPlugin>;
	readonly options: DevstackOptions;
}
