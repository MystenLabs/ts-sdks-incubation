import { account } from '../../../src/plugins/account/index.ts';
import * as SealPublic from '../../../src/plugins/seal/index.ts';
import {
	seal,
	sealFor,
	type SealKeyManager,
	type SealResolved,
} from '../../../src/plugins/seal/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import type { NetworkConfig } from '../../../src/substrate/network.ts';
import type { ResourceValueOf } from '../../../src/substrate/plugin.ts';

const localNet: NetworkConfig<'local'> = { mode: 'local', chain: chainId('sui:localnet') };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('sui:testnet-fork'),
	checkpoint: '1',
};

const publisher = account('publisher');

export const _localSeal = seal({ mode: 'local-keygen', signer: publisher });
type LocalSealResolved = ResourceValueOf<typeof _localSeal>;
export const _resolvedShape: SealResolved = null as never as LocalSealResolved;
export const _keyServerUrl: string = (null as never as LocalSealResolved).keyServerUrl;
export const _manager: SealKeyManager | null = (null as never as LocalSealResolved).manager;
// @ts-expect-error — rotate is not exposed until it has a real implementation
export const _rotate = (null as never as SealKeyManager).rotate;

export const _localNamespace = sealFor(localNet).localKeygen({ signer: publisher });

export const _magicStringSignerRefused = seal({
	mode: 'local-keygen',
	// @ts-expect-error — signer is a direct account member ref, not a magic-string holder
	signer: { accountName: 'publisher' },
});

// @ts-expect-error — local-keygen is absent on fork-mode namespaces
export const _forkLocalKeygenRefused = sealFor(forkNet).localKeygen({ signer: publisher });

type NoManagerTagConstructor = typeof SealPublic extends { makeSealManagerTag: unknown }
	? never
	: true;
export const _noManagerTagConstructor: NoManagerTagConstructor = true;
