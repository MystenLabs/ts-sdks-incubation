// Regression: a caller-supplied lifecycle-prune selection that INCLUDES
// a `per-app-shared` group pinned by a live sibling must NOT remove that
// group. The default selection (`defaultLifecyclePruneSelection`) already
// drops pinned shared groups, but a selection built outside that path
// (the interactive picker, a scripted `--all`, or a programmatic caller)
// could still name a pinned group's key. `runLifecyclePrune` re-applies
// the SAME pinning predicate via `enforcePinnedLifecyclePruneSelection`
// so the shared resource a live sibling depends on survives regardless of
// how the selection was constructed.

import { describe, expect, it } from 'vitest';

import {
	enforcePinnedLifecyclePruneSelection,
	lifecyclePruneGroupKey,
	type LifecyclePruneGroup,
	type LifecyclePruneInventory,
	type LifecyclePruneSelection,
} from '../../../src/orchestrators/lifecycle-prune/index.ts';
import { PER_APP_SHARED_STACK } from '../../../src/substrate/runtime/managed-container.ts';

const group = (
	over: Partial<LifecyclePruneGroup> & Pick<LifecyclePruneGroup, 'app' | 'stack'>,
): LifecyclePruneGroup => ({
	key: lifecyclePruneGroupKey(over.app, over.stack),
	live: false,
	livePids: [],
	shared: false,
	sharedKind: null,
	autoPrunable: false,
	containers: 1,
	runningContainers: 0,
	networks: 1,
	volumes: 1,
	images: 0,
	...over,
});

const ALL_RESOURCES = { containers: true, networks: true, volumes: true, images: true } as const;

describe('enforcePinnedLifecyclePruneSelection', () => {
	it('drops a per-app-shared group from a caller selection when a sibling stack is live', () => {
		const sharedKey = lifecyclePruneGroupKey('arena', PER_APP_SHARED_STACK);
		const liveKey = lifecyclePruneGroupKey('arena', 'main');
		const inventory: LifecyclePruneInventory = {
			groups: [
				group({ app: 'arena', stack: 'main', live: true, livePids: [123] }),
				group({
					app: 'arena',
					stack: PER_APP_SHARED_STACK,
					shared: true,
					sharedKind: 'per-app-shared',
				}),
			],
		};
		// Caller supplies BOTH the live stack and the pinned shared group —
		// the live stack is dropped (live), and the shared group is dropped
		// because its app still has a live sibling.
		const selection: LifecyclePruneSelection = {
			groupKeys: [liveKey, sharedKey],
			resources: ALL_RESOURCES,
			dryRun: false,
		};
		const resolved = enforcePinnedLifecyclePruneSelection(inventory, selection);
		expect(resolved.map((g) => g.key)).not.toContain(sharedKey);
		// The live stack itself is still resolved here (run() skips it as a
		// live group later); the pinning filter only drops shared groups.
		expect(resolved.map((g) => g.key)).toEqual([liveKey]);
	});

	it('keeps a per-app-shared group when no sibling stack is live', () => {
		const sharedKey = lifecyclePruneGroupKey('arena', PER_APP_SHARED_STACK);
		const inventory: LifecyclePruneInventory = {
			groups: [
				group({ app: 'arena', stack: 'main', live: false }),
				group({
					app: 'arena',
					stack: PER_APP_SHARED_STACK,
					shared: true,
					sharedKind: 'per-app-shared',
				}),
			],
		};
		const selection: LifecyclePruneSelection = {
			groupKeys: [sharedKey],
			resources: ALL_RESOURCES,
			dryRun: false,
		};
		const resolved = enforcePinnedLifecyclePruneSelection(inventory, selection);
		expect(resolved.map((g) => g.key)).toEqual([sharedKey]);
	});

	it('does not pin a per-app-shared group across a different app with a live sibling', () => {
		const sharedKey = lifecyclePruneGroupKey('arena', PER_APP_SHARED_STACK);
		const inventory: LifecyclePruneInventory = {
			groups: [
				// A live sibling under a DIFFERENT app must not pin arena's shared group.
				group({ app: 'wallet', stack: 'main', live: true, livePids: [7] }),
				group({
					app: 'arena',
					stack: PER_APP_SHARED_STACK,
					shared: true,
					sharedKind: 'per-app-shared',
				}),
			],
		};
		const selection: LifecyclePruneSelection = {
			groupKeys: [sharedKey],
			resources: ALL_RESOURCES,
			dryRun: false,
		};
		const resolved = enforcePinnedLifecyclePruneSelection(inventory, selection);
		expect(resolved.map((g) => g.key)).toEqual([sharedKey]);
	});
});
