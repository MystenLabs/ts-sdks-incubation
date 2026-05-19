// Canonical Pyth feed ids used across tests. Identifiers are universal
// across all Pyth deployments (mainnet hex). Re-exported here so tests
// can rely on a stable import path without going through the public
// service surface.

export const PYTH_FEED_IDS = {
	SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
	DEEP: '0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff',
	USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
} as const;

export type PythFeedLabel = keyof typeof PYTH_FEED_IDS;
