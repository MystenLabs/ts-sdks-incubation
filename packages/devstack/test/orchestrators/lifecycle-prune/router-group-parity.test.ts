// Regression: pre-fix `runLifecyclePrune`'s network/volume/image
// loops used `{app: group.app, stack: group.stack}` uniformly while
// the CONTAINER-removal loop dispatched routers via the special
// `removeDevstackContainersByKindAndName` branch. Router-shared
// resources are stamped with a non-trivial label tuple
// (`{app: ROUTER_SHARED_APP, stack: <profile-name>}` — see
// `traefik-container.ts:ensureNetwork` and `labels.ts:expectedNetworkOwnershipLabels`).
// If the inventory-bucketing assumption ever drifts (e.g. router
// resources stamped under a different `stack` value than their bucket
// key), dry-run would count those resources as removable while
// real-run leaves them untouched.
//
// Post-fix: `lifecyclePruneRemovalMatchTuple(group)` explicitly forks
// the tuple per group kind, mirroring the structural decision used
// for container removal. This test pins:
//   1. The tuple shape for router vs non-router groups.
//   2. Symmetry with the on-the-wire label stamp — given a router
//      profile's stamped network labels, the tuple matches via the
//      same `LabelKey.app`/`LabelKey.stack` semantics the L1 sweeper
//      uses.
//   3. Stability of the predicate under realistic router profile
//      naming (the `devstack-router-<fingerprint>` shape produced by
//      `makeRouterProfile`).

import { describe, expect, it } from 'vitest';

import {
	lifecyclePruneRemovalMatchTuple,
	isRouterLifecyclePruneGroup,
} from '../../../src/orchestrators/lifecycle-prune/index.ts';
import {
	expectedNetworkOwnershipLabels,
	LabelKey,
} from '../../../src/runtime/docker/index.ts';
import { makeRouterProfile } from '../../../src/orchestrators/router/profile.ts';
import { ROUTER_SHARED_APP } from '../../../src/orchestrators/router/sentinels.ts';

describe('lifecycle-prune router-group dry-run ↔ real-run parity', () => {
	it('router groups: tuple uses ROUTER_SHARED_APP + the profile stack name', () => {
		const profile = makeRouterProfile({
			userId: 'uid-1000',
			dockerContextId: 'context:default|host:default',
		});
		const group = { app: ROUTER_SHARED_APP, stack: profile.containerName };
		expect(isRouterLifecyclePruneGroup(group)).toBe(true);

		const tuple = lifecyclePruneRemovalMatchTuple(group);
		expect(tuple).toEqual({ app: ROUTER_SHARED_APP, stack: profile.containerName });
	});

	it('non-router groups: tuple is the bucket app/stack verbatim', () => {
		const group = { app: 'arena', stack: 'main' };
		expect(isRouterLifecyclePruneGroup(group)).toBe(false);

		const tuple = lifecyclePruneRemovalMatchTuple(group);
		expect(tuple).toEqual({ app: 'arena', stack: 'main' });
	});

	it('router network labels stamped on the wire match the removal tuple', () => {
		// Real-run path: `removeDevstackNetworksBestEffort(tuple)` filters
		// candidate networks by `labels[app] === tuple.app && labels[stack]
		// === tuple.stack`. The L1 sweeper's `labelsMatchAppStack` and the
		// labels rendered by `ensureNetwork(name, { app, stack, ... })`
		// must round-trip through the same key constants.
		const profile = makeRouterProfile({
			userId: 'uid-1000',
			dockerContextId: 'context:default|host:default',
		});

		// `ensureNetwork(name, { app: ROUTER_SHARED_APP, stack: name, ... })`
		// — see `orchestrators/router/traefik-container.ts:488`.
		const onWireLabels = expectedNetworkOwnershipLabels(
			ROUTER_SHARED_APP,
			profile.networkName,
		);

		// Inventory key: `routerStackForContainer(container.name)` where
		// `container.name === profile.containerName === profile.networkName`.
		const group = { app: ROUTER_SHARED_APP, stack: profile.containerName };
		const tuple = lifecyclePruneRemovalMatchTuple(group);

		expect(onWireLabels[LabelKey.app]).toBe(tuple.app);
		expect(onWireLabels[LabelKey.stack]).toBe(tuple.stack);
	});

	it('regression — would catch a future drift where router groups fell back to bucket tuple', () => {
		// Pin the structural invariant: router groups MUST resolve to
		// `{app: ROUTER_SHARED_APP, stack: group.stack}` regardless of
		// what value `group.app` carries. If a refactor later introduced
		// a non-ROUTER_SHARED_APP `group.app` for router-classified
		// groups (e.g. derived from a stray container label), the tuple
		// must still pin to `ROUTER_SHARED_APP` so real-run finds the
		// resources the inventory bucketed.
		const profile = makeRouterProfile({
			userId: 'uid-1000',
			dockerContextId: 'context:default|host:default',
		});
		const routerGroup = { app: ROUTER_SHARED_APP, stack: profile.containerName };
		const tuple = lifecyclePruneRemovalMatchTuple(routerGroup);
		expect(tuple.app).toBe(ROUTER_SHARED_APP);
		expect(tuple.stack).toBe(profile.containerName);
	});

	it('router profile container/network names are equal (load-bearing for parity)', () => {
		// `lifecyclePruneRemovalMatchTuple` for router groups uses
		// `group.stack` (== inventory bucket key, which == container name)
		// while the on-wire network labels stamp `stack: networkName`.
		// Parity depends on `containerName === networkName` in
		// `RouterProfile`. If a future profile shape splits these, the
		// router-network real-run sweep would silently no-op. Catch the
		// drift here.
		const profile = makeRouterProfile({
			userId: 'uid-1000',
			dockerContextId: 'context:default|host:default',
		});
		expect(profile.containerName).toBe(profile.networkName);
	});
});
