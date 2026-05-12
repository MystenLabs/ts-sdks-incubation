// Minimal devstack config: sui localnet, manifest, wallet-app, vite
// frontend, and one Move package published as alice. Runs a single
// `runTransaction` after publish to demonstrate the setup pattern.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { defineDevstackConfig } from '@mysten-incubation/devstack-next';
import {
	publishMove,
	publishViaSuiCli,
	runTransaction,
	viteDevServer,
} from '@mysten-incubation/devstack-next/helpers';
import {
	accounts,
	manifest,
	sui,
	walletApp,
} from '@mysten-incubation/devstack-next/plugins';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_DIR = resolve(HERE, 'move/hello');

const a = accounts({ specs: { alice: {}, bob: {} } });

const helloPublish = publishMove({
	name: 'hello',
	path: HELLO_DIR,
	signer: a.pool.get('signer', { name: 'alice' }),
	publish: publishViaSuiCli,
});

const wallet = walletApp.create({
	accounts: [
		{ name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
		{ name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
	],
	allowedOrigins: ['http://localhost:5180'],
});

const m = manifest({
	packages: [helloPublish.get('package')],
	endpoints: [sui.get('endpoint'), sui.get('faucetEndpoint'), wallet.get('endpoint')],
	accounts: [
		a.pool.get('account', { name: 'alice' }),
		a.pool.get('account', { name: 'bob' }),
	],
});

const mintGreeting = runTransaction({
	name: 'mint-greeting',
	signer: a.pool.get('signer', { name: 'alice' }),
	deps: { hello: helloPublish.get('package') },
	build: async ({ signer, rpcUrl, deps }) => {
		const tx = new Transaction();
		tx.moveCall({
			target: `${deps.hello.packageId}::hello::mint`,
			arguments: [tx.pure.vector('u8', Array.from(new TextEncoder().encode('hello, sui')))],
		});
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
		const result = await client.signAndExecuteTransaction({
			signer,
			transaction: tx,
			options: { showEffects: true },
		});
		if (result.effects?.status?.status !== 'success') {
			throw new Error(`mint-greeting: ${result.effects?.status?.error ?? 'unknown'}`);
		}
		await client.waitForTransaction({ digest: result.digest });
		return { digest: result.digest };
	},
});

const dev = viteDevServer({
	port: 5180,
	gates: [helloPublish.get('package'), wallet.get('full')],
});

export default defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }),
		a.pool,
		a.fund,
		helloPublish,
		mintGreeting,
		m,
		wallet,
		dev,
	],
});
