// Own-process PID accessor.
//
// Centralizes `process.pid` reads so:
//   1. The cross-process protocol modules (roster, snapshot-reservation,
//      liveness, atomic-write tempfiles, port-broker owner ids) have a
//      single named entry point instead of scattering the global read.
//   2. Tests that want to simulate a peer can swap this module in a
//      vitest mock without monkey-patching `process` globally.
//
// The implementation is intentionally trivial — `() => process.pid` —
// and lives in its own module so call sites read with a meaningful name
// rather than a raw global.

/** This process's PID. Module-level indirection so cross-process
 *  protocol modules read through one named entry point. */
export const selfPid = (): number => process.pid;
