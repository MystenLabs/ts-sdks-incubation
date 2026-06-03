// Reconcile subsystem barrel.
//
// The unified lifecycle-reconcile seam (redesign §2). Phase A: the seam
// contract types (`./spec.ts`, P0) + the graph-axis reconcile body
// (`./graph.ts`, P1). Phase B (P2/P3): the fs-plan executor
// (`./fs-plan.ts`) + the flat label-scope reconcile body (`./label.ts`),
// through which wipe + prune now route. Later phases fill the swap-tree
// fsPlan family / cachePolicy / precondition / locks / ownership slots and
// route the remaining flows (up / down / restore / capture) through here.

export * from './spec.ts';
export * from './graph.ts';
export * from './fs-plan.ts';
export * from './label.ts';
