// Re-export shim — the supervisor lives under `./supervisor/`.
//
// The monolith was split per backlog #38 (now closed). This file
// preserves the import path `'./supervisor.ts'` / `'../supervisor.ts'`
// for existing callers (CLI, e2e tests, substrate runtime barrel).
// New code should import directly from `./supervisor/index.ts`; the
// shim will be deleted in a follow-up sweep.

export * from './supervisor/index.ts';
