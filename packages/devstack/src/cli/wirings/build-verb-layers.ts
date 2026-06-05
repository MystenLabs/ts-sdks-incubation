// Re-export shim. The Layer-composition helpers moved DOWN into
// `orchestrators/layers.ts` so both `api/run-stack.ts` and `cli/` can
// import them without an upward layering violation (today `api/` cannot
// import `cli/`). Existing CLI consumers (up/apply/snapshot/wipe + the
// snapshot-matrix e2e) keep importing from here unchanged; a later step
// repoints them at the orchestrators module directly.
export { buildVerbLayers, buildDirectSnapshotLayers } from '../../orchestrators/layers.ts';
