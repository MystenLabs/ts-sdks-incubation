// Wire-level HTTP path contract between the wallet-app server
// (`services/wallet/internal.ts`) and the browser-side dev-wallet
// adapter. Both ends import (or in dev-wallet's case mirror — see
// below) from this module so renames are caught at compile time.
//
// Why dev-wallet doesn't directly import this:
//   `packages/devstack` already lists `@mysten-incubation/dev-wallet`
//   as a (peer/dev) dependency — the codegen emits browser glue that
//   wires the devstack adapter. Adding the reverse edge (dev-wallet →
//   devstack) closes the workspace cycle and breaks turbo's build
//   ordering. Instead, dev-wallet duplicates the same const-object
//   locally at `packages/dev-wallet/src/adapters/devstack-paths.ts`
//   and a sync test in this package (`protocol.test.ts`) imports both
//   and asserts byte-for-byte equality. The pair stays in lock-step
//   while keeping the dependency graph acyclic.
//
// Adding a new route:
//   1. Append a constant here.
//   2. Mirror it into `packages/dev-wallet/src/adapters/devstack-paths.ts`.
//   3. Wire it into the server's router in
//      `services/wallet/internal.ts`.
//   4. Wire it into the dev-wallet adapter's fetch sites in
//      `packages/dev-wallet/src/adapters/devstack-adapter.ts`.
//   5. The `protocol.test.ts` sync assertion catches missing mirrors.

export const WalletHttpPath = {
	HEALTH: '/api/v1/devstack/health',
	ACCOUNTS: '/api/v1/devstack/accounts',
	SIGN_TX: '/api/v1/devstack/sign-transaction',
	SIGN_PERSONAL_MESSAGE: '/api/v1/devstack/sign-personal-message',
	// Fork-control relay — added 2026-05-19 alongside the dev-wallet
	// fork panel (sui-fork-phase-5 Subtopic 6). The browser-side
	// adapter uses these to drive `ForkControl` admin RPCs through the
	// wallet-app server (advanceClock, advanceCheckpoint, status,
	// impersonation slots). Server-side routes are stub 501s pending
	// the relay wiring (P5.8.4); the keys live here so the dev-wallet
	// adapter stays in lock-step with the protocol sync test.
	FORK_STATUS: '/api/v1/devstack/fork/status',
	FORK_ADVANCE_CLOCK: '/api/v1/devstack/fork/advance-clock',
	FORK_ADVANCE_CHECKPOINT: '/api/v1/devstack/fork/advance-checkpoint',
	FORK_IMPERSONATIONS: '/api/v1/devstack/fork/impersonations',
} as const;

export type WalletHttpPathValue = (typeof WalletHttpPath)[keyof typeof WalletHttpPath];
