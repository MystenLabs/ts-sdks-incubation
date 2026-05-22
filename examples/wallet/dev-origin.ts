export const WALLET_DEV_SERVER_HOST = '127.0.0.1';
export const WALLET_DEV_SERVER_PORT = 5174;
export const WALLET_DEV_ORIGIN =
	`http://${WALLET_DEV_SERVER_HOST}:${WALLET_DEV_SERVER_PORT}` as const;
export const WALLET_ROUTER_DEV_ORIGIN = 'http://dev.wallet.wallet.localhost:5175' as const;
