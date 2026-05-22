import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	wallet,
	walrus,
	seal,
	sui,
	type Stack,
	walCoin,
} from '@mysten-incubation/devstack';

import { PRIVATE_CONTENT_APP_PORT } from './devstack.shared.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const localnet = sui();
const walrusCluster = walrus({ local: { nodeCount: 4 } });
const wal = walCoin(walrusCluster);
const suiFunding = [{ coin: 'sui', amount: 1_000_000_000n }] as const;
const walFunding = [...suiFunding, { coin: wal, amount: 500_000_000n }] as const;
const sealPublisher = account('seal_publisher', {
	kind: 'ephemeral',
	funding: suiFunding,
});
const publisher = account('publisher', {
	kind: 'ephemeral',
	funding: walFunding,
});
const alice = account('alice', {
	kind: 'ephemeral',
	funding: walFunding,
});
const bob = account('bob', {
	kind: 'ephemeral',
	funding: walFunding,
});

const vault = localPackage('vault', {
	sourcePath: resolve(HERE, 'move/vault'),
	publisher: sealPublisher,
});
const sealKeyServer = seal({ mode: 'local-keygen', signer: sealPublisher });
const devWallet = wallet({
	accounts: [publisher, alice, bob],
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: PRIVATE_CONTENT_APP_PORT,
	ready: { kind: 'http' },
	after: [localnet, vault, walrusCluster, sealKeyServer, devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app] });

export default stack;
