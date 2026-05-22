import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	coin,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5182;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}` as const;
const ROUTER_DEV_ORIGIN = 'http://dev.deepbook-trader.deepbook-trader.localhost:5175' as const;
const ALICE_SUI_FUND_MIST = 1_000_000_000n;
const ALICE_DEEP_FUND_BASE_UNITS = 15_000_000n;

const localnet = sui();
const publisher = account('publisher');
const deepPackage = localPackage('deep', {
	sourcePath: resolve(HERE, 'move/deep'),
	publisher,
});
const deep = coin.fromPackage(deepPackage, 'DEEP');
const alice = account('alice', {
	kind: 'ephemeral',
	name: 'alice',
	funding: [
		{ coin: 'sui', amount: ALICE_SUI_FUND_MIST },
		{ coin: deep, amount: ALICE_DEEP_FUND_BASE_UNITS },
	],
});
const devWallet = wallet({
	accounts: [alice],
	enableRouter: true,
	allowedOrigins: [DEV_ORIGIN, ROUTER_DEV_ORIGIN],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app], stackName: 'deepbook-trader' });

export default stack;
