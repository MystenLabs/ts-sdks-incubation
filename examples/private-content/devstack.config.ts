// Private-content app — Seal-encrypted file vault on top of sui-localnet,
// walrus, and a single Open-mode seal key server. The vault Move package
// is published as the publisher; access control runs entirely client-side
// via SessionKey + the `vault::vault::seal_approve` dry-run policy fn.
//
// First `pnpm dev` builds two heavy local arm64 images: walrus (~10 min
// cold) and seal (~5–8 min). Subsequent runs hit the docker layer cache.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineDevstackConfig } from '@mysten-incubation/devstack-next';
import {
	publishMove,
	publishViaSuiCli,
	viteDevServer,
} from '@mysten-incubation/devstack-next/helpers';
import {
	accounts,
	manifest,
	sealLocalnet,
	sui,
	walletApp,
	walrus,
} from '@mysten-incubation/devstack-next/plugins';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, 'move/vault');

const a = accounts({ specs: { publisher: {}, alice: {}, bob: {} } });

const vaultPublish = publishMove({
	name: 'vault',
	path: VAULT_DIR,
	signer: a.pool.get('signer', { name: 'publisher' }),
	publish: publishViaSuiCli,
});

const w = walrus({ nodeCount: 4 });

const sl = sealLocalnet({
	signer: a.pool.get('signer', { name: 'publisher' }),
});

const m = manifest({
	packages: [vaultPublish.get('package'), sl.publish.get('package'), w.register!.get('package')],
	accounts: [
		a.pool.get('account', { name: 'publisher' }),
		a.pool.get('account', { name: 'alice' }),
		a.pool.get('account', { name: 'bob' }),
	],
	extras: {
		// Seal key server projection — the frontend reads
		// `manifest.extras.sealKeyServer` to wire SessionKey + the
		// SealClient against this localnet key server.
		sealKeyServer: sl.register.get('keyServer'),
	},
});

const wallet = walletApp.create({
	accounts: [
		{ name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
		{ name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
		{ name: 'publisher', signer: a.pool.get('signer', { name: 'publisher' }) },
	],
});

const dev = viteDevServer({
	gates: [vaultPublish.get('package'), sl.register.get('keyServer'), wallet.get('full')],
});

export default defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }),
		a.pool,
		a.fund,
		// Walrus full bring-up: image, deploy, register, exchange,
		// and all storage nodes. `appNetwork` aggregates the nodes
		// so consumers can Dep on the committee as a unit.
		w.appNetwork,
		w.deploy!.deploy,
		w.register!,
		w.exchange!,
		...w.nodes,
		// Seal stack: image (optional — undefined when `image:` override
		// is set), keygen, source/publish, KeyServer register, container,
		// schema instance. The engine deduplicates by producer __id, so
		// listing both `sl.publish` here AND threading it into a Dep
		// elsewhere is a no-op.
		...(sl.image ? [sl.image] : []),
		sl.keygenContainer,
		sl.keygen,
		sl.source,
		sl.publish,
		sl.register,
		sl.container,
		sl.instance,
		vaultPublish,
		m,
		wallet,
		dev,
	],
});
