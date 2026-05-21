// Cross-process protocol — barrel for the three on-disk artifacts.
//
// Architecture § Cross-process safety protocol. Three files under
// `<runtime-root>/stacks/<stack>/`:
//
//   - `stack.lock`              → stack-lock.ts
//   - `roster.json`             → roster.ts (+ container-claims.json sibling)
//   - `snapshot.reservation`    → snapshot-reservation.ts
//
// `liveness.ts` is the shared PID + start-time predicate used by all
// three.

export * from './liveness.ts';
export * from './stack-lock.ts';
export * from './roster.ts';
export * from './snapshot-reservation.ts';
export * from './command-channel/index.ts';
