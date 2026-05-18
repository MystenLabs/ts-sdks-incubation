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
} as const;

export type DevstackWalletHttpPathValue =
	(typeof DEVSTACK_WALLET_HTTP_PATH)[keyof typeof DEVSTACK_WALLET_HTTP_PATH];
