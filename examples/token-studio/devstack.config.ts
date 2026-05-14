// Token-studio app — single managed coin with TreasuryCap-gated minting.
// Alice doubles as publisher (holds the TreasuryCap so the UI's
// "TreasuryCap holder" badge resolves).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	defineDevstack,
	hostProcess,
	manifest,
	pickCreatedByTypeIncludes,
	pickCreatedByTypeSuffix,
	publishMove,
	suiLocalnet,
	walletApp,
} from '@mysten-incubation/devstack-effect';
import type { SuiObjectChange } from '@mysten-incubation/devstack-effect';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGED_COIN_DIR = resolve(HERE, 'move/managed_coin');

const a = accounts({ alice: {}, bob: {}, carol: {} });

const captureCoinObjects = (changes: ReadonlyArray<SuiObjectChange>) => {
	const out: Record<string, string> = {};
	const t = pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<');
	if (t !== undefined) out.treasuryCapId = t;
	const md = pickCreatedByTypeIncludes(changes, '::coin::CoinMetadata<');
	if (md !== undefined) out.metadataId = md;
	const up = pickCreatedByTypeSuffix(changes, '0x2::package::UpgradeCap');
	if (up !== undefined) out.upgradeCapId = up;
	return out;
};

// Publish as alice — same account holds the TreasuryCap. The `coins:`
// shortcut registers the managed_coin Move type into the manifest's
// coin namespace automatically.
const managedCoinPublish = publishMove({
	name: 'managed_coin',
	path: MANAGED_COIN_DIR,
	signer: a.alice,
	capture: captureCoinObjects,
	coins: [{ name: 'managed_coin', module: 'managed_coin', type: 'MANAGED_COIN', decimals: 6 }],
});

const wallet = walletApp({
	accounts: [a.alice, a.bob, a.carol],
	// Router-fronted dev URL + legacy direct port.
	allowedOrigins: ['http://dev.token-studio.localhost:5175', 'http://localhost:5173'],
});

// Vite spawns on a local port; the supervisor publishes a Traefik
// file-provider entry so the public URL surfaces as
// `http://dev.token-studio.localhost:5175`. Ready probe targets the
// local port so we don't depend on router warm-up.
const dev = hostProcess({
	name: 'frontend.dev-server',
	command: 'pnpm',
	args: ['exec', 'vite', '--port', '5173', '--strictPort'],
	readyProbe: { kind: 'http', url: 'http://localhost:5173', timeoutMs: 60_000 },
	endpoint: { name: 'dev-server', kind: 'dev-server' },
	traefik: { service: 'dev', entrypoint: 'vite', localPort: 5173 },
	dependsOn: [managedCoinPublish, wallet],
});

const m = manifest();

export default defineDevstack([
	suiLocalnet(),
	a.alice,
	a.bob,
	a.carol,
	managedCoinPublish,
	m,
	wallet,
	dev,
]);
