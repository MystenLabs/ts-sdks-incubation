// `StateStoreKeys` is the canonical state-store key catalog. Bit-flip
// tests here ensure the on-disk key strings stay stable across
// refactors — a silent change to one of these formats invalidates
// every snapshot taken before the change AND every cached entry the
// supervisor relied on for the resume path.
//
// Add a new builder → add a key shape assertion below.

import { describe, expect, it } from 'vitest';
import { StateStoreKeys } from './state-store-keys.js';

describe('StateStoreKeys — canonical key shapes', () => {
	it('publishMove: publishMove/<name>/<sourceHash>/<chainId>', () => {
		expect(
			StateStoreKeys.publishMove({
				packageName: 'hello',
				sourceHash: 'abc',
				chainId: '0xchain',
			}),
		).toBe('publishMove/hello/abc/0xchain');
	});

	it('coinMint: coin/mint/<chainId>/<treasuryCapId>/<recipient>/<amount>', () => {
		expect(
			StateStoreKeys.coinMint({
				chainId: '0xchain',
				treasuryCapId: '0xcap',
				recipient: '0xrec',
				amount: 1000n,
			}),
		).toBe('coin/mint/0xchain/0xcap/0xrec/1000');
	});

	it('coinMint: accepts a stringified amount verbatim', () => {
		expect(
			StateStoreKeys.coinMint({
				chainId: '0xchain',
				treasuryCapId: '0xcap',
				recipient: '0xrec',
				amount: '1000000000',
			}),
		).toBe('coin/mint/0xchain/0xcap/0xrec/1000000000');
	});

	it('actionTx: tx/<actionName>/<chainId>/<signer>/<userKey>', () => {
		expect(
			StateStoreKeys.actionTx({
				actionName: 'mint-batch',
				chainId: '0xchain',
				signerAddress: '0xalice',
				userKey: 'k1',
			}),
		).toBe('tx/mint-batch/0xchain/0xalice/k1');
	});

	it('walrusDeployOutput: walrus/deploy-output/<chainId>', () => {
		expect(StateStoreKeys.walrusDeployOutput({ chainId: '0xchain' })).toBe(
			'walrus/deploy-output/0xchain',
		);
	});

	it('walrusSeedWal: walrus/seed-wal/<chainId>/<exchange>/<account>', () => {
		expect(
			StateStoreKeys.walrusSeedWal({
				chainId: '0xchain',
				exchangeObjectId: '0xexch',
				accountAddress: '0xacc',
			}),
		).toBe('walrus/seed-wal/0xchain/0xexch/0xacc');
	});

	it('sealBlsKeypair: seal/bls-keypair/<chainId>', () => {
		expect(StateStoreKeys.sealBlsKeypair({ chainId: '0xchain' })).toBe('seal/bls-keypair/0xchain');
	});

	it('sealKeyServerId: seal/key-server-id/<chainId>', () => {
		expect(StateStoreKeys.sealKeyServerId({ chainId: '0xchain' })).toBe(
			'seal/key-server-id/0xchain',
		);
	});

	it('deepbookPools: deepbook/pools/<chainId>/<packageId>/<poolsHash>', () => {
		expect(
			StateStoreKeys.deepbookPools({
				chainId: '0xchain',
				packageId: '0xpkg',
				poolsHash: 'hash',
			}),
		).toBe('deepbook/pools/0xchain/0xpkg/hash');
	});

	it('deepbookMarginPools: deepbook/margin-pools/<chainId>/<packageId>/<configHash>', () => {
		expect(
			StateStoreKeys.deepbookMarginPools({
				chainId: '0xchain',
				packageId: '0xpkg',
				configHash: 'h',
			}),
		).toBe('deepbook/margin-pools/0xchain/0xpkg/h');
	});

	it('deepbookMarginSeed: deepbook/margin-seed/<chainId>/<packageId>/<trailing>', () => {
		expect(
			StateStoreKeys.deepbookMarginSeed({
				chainId: '0xchain',
				packageId: '0xpkg',
				trailing: '0xsigner/amounthash',
			}),
		).toBe('deepbook/margin-seed/0xchain/0xpkg/0xsigner/amounthash');
	});

	it('deepbookBalanceManager: deepbook/market-maker/balance-manager/<chainId>/<pkg>/<signer>[/<sub>]', () => {
		expect(
			StateStoreKeys.deepbookBalanceManager({
				chainId: '0xchain',
				packageId: '0xpkg',
				signerAddress: '0xsigner',
			}),
		).toBe('deepbook/market-maker/balance-manager/0xchain/0xpkg/0xsigner');
		expect(
			StateStoreKeys.deepbookBalanceManager({
				chainId: '0xchain',
				packageId: '0xpkg',
				signerAddress: '0xsigner',
				subKey: 'shared',
			}),
		).toBe('deepbook/market-maker/balance-manager/0xchain/0xpkg/0xsigner/shared');
	});

	it('pythPackage: pyth/package/<chainId>/<packageId>/<feedsHash>', () => {
		expect(
			StateStoreKeys.pythPackage({
				chainId: '0xchain',
				packageId: '0xpkg',
				feedsHash: 'fh',
			}),
		).toBe('pyth/package/0xchain/0xpkg/fh');
	});

	it('pythPusher: pyth/pusher/<chainId>/<packageId>/<signer>', () => {
		expect(
			StateStoreKeys.pythPusher({
				chainId: '0xchain',
				packageId: '0xpkg',
				signerAddress: '0xsigner',
			}),
		).toBe('pyth/pusher/0xchain/0xpkg/0xsigner');
	});

	it('dockerOneShot: dockerOneShot/<name>/<inputsHash>', () => {
		expect(
			StateStoreKeys.dockerOneShot({
				name: 'seal.keygen',
				inputsHash: 'abc123',
			}),
		).toBe('dockerOneShot/seal.keygen/abc123');
	});
});
