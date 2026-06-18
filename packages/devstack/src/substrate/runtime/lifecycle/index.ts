// Lifecycle subsystem barrel.
//
// Per-plugin state machine, dep-graph resolution, ready-gate
// composition, watch attribution, selective-restart planning, signal
// handling. The supervisor (`../supervisor.ts`) is the orchestrator
// that composes these.

export * from './state-machine.ts';
export * from './dep-graph.ts';
export * from './graph-input-id.ts';
export * from './plugin-registry.ts';
export * from './ready-gate.ts';
export * from './watch-attribution.ts';
export * from './file-watcher.ts';
export * from './selective-restart.ts';
export * from './signals.ts';
