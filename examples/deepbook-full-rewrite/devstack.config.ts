import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	localPackage,
	postgres,
	wallet,
	deepbook,
	USDC_MARGIN_DEFAULTS,
	SUI_MARGIN_DEFAULTS,
	DEFAULT_POOL_RISK_CONFIG,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const pythPusher = account('pyth-pusher');
const marketMaker = account('market-maker');
const alice = account('alice');
const bob = account('bob');

const mockUsdc = localPackage('mock_usdc', {
	sourcePath: resolve(HERE, 'move/mock_usdc'),
	publisher,
});

const pg = postgres({ databases: ['deepbook'] });

const dex = deepbook({
	mode: 'local',
	publisher,
	postgres: pg,
	coins: [mockUsdc],
	pools: [
		{
			name: 'deep_sui',
			base: 'DEEP',
			quote: 'SUI',
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
		{
			name: 'sui_usdc',
			base: 'SUI',
			quote: 'USDC',
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
	],
	pyth: {
		pusher: pythPusher,
		feeds: [
			{ symbol: 'SUI', feedId: SUI_PRICE_FEED_ID, initialPrice: 350_000_000n },
			{ symbol: 'DEEP', feedId: DEEP_PRICE_FEED_ID, initialPrice: 10_000_000n },
			{ symbol: 'USDC', feedId: USDC_PRICE_FEED_ID, initialPrice: 100_000_000n },
		],
	},
	margin: {
		assets: [USDC_MARGIN_DEFAULTS, SUI_MARGIN_DEFAULTS],
		pools: [{ pool: 'sui_usdc', risk: DEFAULT_POOL_RISK_CONFIG }],
	},
	indexer: true,
	server: true,
	marketMaker: {
		signer: marketMaker,
		strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 3 },
	},
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	publisher,
	pythPusher,
	marketMaker,
	alice,
	bob,
	mockUsdc,
	pg,
	dex,
	wallet({ accounts: 'all' }),
);

export default stack;
