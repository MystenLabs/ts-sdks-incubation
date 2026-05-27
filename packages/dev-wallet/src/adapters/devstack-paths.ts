// Mirror of `packages/devstack/src/plugins/wallet/protocol.ts` `WalletHttpPath`.
// Duplicated here rather than imported because devstack already
// (peer-)depends on `@mysten-incubation/dev-wallet` for codegen-emitted
// wallet glue, and adding the reverse edge would close the workspace
// cycle and break turbo's build ordering.

export const DEVSTACK_WALLET_HTTP_PATH = {
	HEALTH: '/api/v1/devstack/health',
	ACCOUNTS: '/api/v1/devstack/accounts',
	SIGN_TRANSACTION: '/api/v1/devstack/sign-transaction',
	SIGN_PERSONAL_MESSAGE: '/api/v1/devstack/sign-personal-message',
} as const;

export type DevstackWalletHttpPathValue =
	(typeof DEVSTACK_WALLET_HTTP_PATH)[keyof typeof DEVSTACK_WALLET_HTTP_PATH];
