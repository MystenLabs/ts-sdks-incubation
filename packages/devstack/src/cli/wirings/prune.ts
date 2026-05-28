// `devstack prune` verb wiring — direct/offline path.
//
// Thin re-export of the L4 helpers in `cli/prune-direct.ts`. The
// orchestration lives at `orchestrators/lifecycle-prune/`; this module
// only adapts the orchestrator's typed surface to the CLI deps shape.

export { makeDirectPruneDeps } from '../prune-direct.ts';
