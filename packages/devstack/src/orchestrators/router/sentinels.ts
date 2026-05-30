// Router-singleton sentinels.
//
// The router orchestrator owns one Traefik container per router profile
// (NOT per-stack); these literals identify that container in label
// matchers, lifecycle-prune predicates, and on-disk profile-state
// fingerprints. Centralizing them here means cleanup, traefik-container,
// and lifecycle-prune all read the same source.
//
// Architecture distilled-doc §"Layer composition" — the router is L3;
// these sentinels are not plugin-author-visible (they're orchestrator-
// owned) but must stay consistent across the router's modules.

import { LabelKey } from '../../runtime/docker/index.ts';

/** Synthetic app name stamped onto the router-singleton container. The
 *  lifecycle-prune orchestrator uses this to distinguish the router
 *  group from per-stack groups (per-stack `wipe` doesn't touch the
 *  router). */
export const ROUTER_SHARED_APP = 'devstack-router';

/** Prefix for the router-singleton container name. The on-disk
 *  profile-state directory under `runtime/router/<profile-fingerprint>/`
 *  is matched against this prefix during profile-state cleanup so a
 *  router-stack removal also drops the profile dir. */
export const ROUTER_CONTAINER_NAME_PREFIX = 'devstack-router-';

/** Value stamped into the L1 generic `LabelKey.kind` slot for router
 *  containers. L1 is plugin-blind: the router orchestrator owns this
 *  literal. */
export const ROUTER_KIND_LABEL_VALUE = 'router';

/** Label key carrying the router profile id (so `docker ps` filters by
 *  profile alone resolve the right router container). Reuses the L1
 *  generic `subkind` slot — same plugin-blind convention as
 *  `LabelKey.kind`. */
export const ROUTER_PROFILE_LABEL = LabelKey.subkind;

/** Bumps when the traefik-container ops shape changes. Mismatched
 *  containers are recreated rather than adopted. */
export const ROUTER_CONTAINER_SPEC_VERSION = '3';
