// Mirror of the devstack-side wallet-server `WalletHttpPath` const-object.
// Duplicated here rather than imported because devstack already
// (peer-)depends on `@mysten-incubation/dev-wallet` for codegen-emitted
// wallet glue, and adding the reverse edge would close the workspace
// cycle and break turbo's build ordering.
//
// Coherence: a sync test on the devstack side imports both copies and
// asserts byte-for-byte equality, so the two stay in lock-step despite
// the duplication. If you update one side, update the other and let
// the test fail loudly if they drift.

export const DEVSTACK_WALLET_HTTP_PATH = {
	HEALTH: '/api/v1/devstack/health',
	ACCOUNTS: '/api/v1/devstack/accounts',
	SIGN_TX: '/api/v1/devstack/sign-transaction',
	SIGN_PERSONAL_MESSAGE: '/api/v1/devstack/sign-personal-message',
	// Fork-control relay: these endpoints surface the `ForkControl` admin
	// RPCs through the wallet-app server so the browser-side fork panel
	// can drive `advanceClock`, `advanceCheckpoint`, status reads, and
	// impersonation slot management without speaking gRPC directly.
	FORK_STATUS: '/api/v1/devstack/fork/status',
	FORK_ADVANCE_CLOCK: '/api/v1/devstack/fork/advance-clock',
	FORK_ADVANCE_CHECKPOINT: '/api/v1/devstack/fork/advance-checkpoint',
	FORK_IMPERSONATIONS: '/api/v1/devstack/fork/impersonations',
} as const;

export type DevstackWalletHttpPathValue =
	(typeof DEVSTACK_WALLET_HTTP_PATH)[keyof typeof DEVSTACK_WALLET_HTTP_PATH];
