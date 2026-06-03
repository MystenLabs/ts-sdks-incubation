// Reconcile subsystem barrel.
//
// The unified lifecycle-reconcile seam (redesign §2). Phase A: the seam
// contract types (`./spec.ts`, P0) + the graph-axis reconcile body
// (`./graph.ts`, P1). Later phases fill the fsPlan / cachePolicy /
// precondition / locks / ownership slots and route the remaining flows
// (up / down / restore / wipe / prune / capture) through here.

export * from './spec.ts';
export * from './graph.ts';
