// Mirror of `@mysten-incubation/devstack`'s `services/wallet/protocol.ts`
// `WalletHttpPath` const-object. Duplicated here rather than imported
// because `packages/devstack` already (peer-)depends on
// `@mysten-incubation/dev-wallet` for the codegen-emitted wallet glue,
// and adding the reverse edge (dev-wallet → devstack) would close the
// workspace cycle and break turbo's build ordering.
//
// Coherence: a sync test in devstack
// (`packages/devstack/src/services/wallet/protocol.test.ts`) imports
// both copies and asserts byte-for-byte equality, so the two stay in
// lock-step despite the duplication. If you update one side, update
// the other and let the test fail loudly if they drift.

export const DEVSTACK_WALLET_HTTP_PATH = {
	HEALTH: '/api/v1/devstack/health',
	ACCOUNTS: '/api/v1/devstack/accounts',
	SIGN_TX: '/api/v1/devstack/sign-transaction',
	SIGN_PERSONAL_MESSAGE: '/api/v1/devstack/sign-personal-message',
	// --- Phase 5 §8 — fork control relay (Subtopic 6) ---
	// These endpoints surface the `ForkControl` admin RPCs through the
	// existing wallet-app server so the browser-side fork panel can
	// drive `advanceClock`, `advanceCheckpoint`, status reads, and
	// impersonation slot management without speaking gRPC directly.
	//
	// TODO(devstack-side wiring): the matching routes do **not** yet
	// exist in `packages/devstack/src/services/wallet/internal.ts` —
	// see `notes/sui-fork-phase-5.md` Subtopic 6 §P5.8.4. Once the
	// orchestrator lands the server side, the protocol sync test
	// (`protocol.test.ts`) will catch any drift.
	FORK_STATUS: '/api/v1/devstack/fork/status',
	FORK_ADVANCE_CLOCK: '/api/v1/devstack/fork/advance-clock',
	FORK_ADVANCE_CHECKPOINT: '/api/v1/devstack/fork/advance-checkpoint',
	FORK_IMPERSONATIONS: '/api/v1/devstack/fork/impersonations',
} as const;

export type DevstackWalletHttpPathValue =
	(typeof DEVSTACK_WALLET_HTTP_PATH)[keyof typeof DEVSTACK_WALLET_HTTP_PATH];
