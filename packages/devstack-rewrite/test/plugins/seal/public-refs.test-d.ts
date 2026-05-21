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
import type { ResolvedOf } from '../../../src/substrate/tag.ts';

const localNet: NetworkConfig<'local'> = { mode: 'local', chain: chainId('sui:localnet') };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('sui:testnet-fork'),
	checkpoint: '1',
};

const publisher = account('publisher');

export const _localSeal = seal({ mode: 'local-keygen', signer: publisher });
type LocalSealResolved = ResolvedOf<typeof _localSeal.provides>;
export const _resolvedShape: SealResolved = null as never as LocalSealResolved;
export const _keyServerUrl: string = (null as never as LocalSealResolved).keyServerUrl;
export const _manager: SealKeyManager | null = (null as never as LocalSealResolved).manager;

export const _localNamespace = sealFor.for(localNet).localKeygen({ signer: publisher });

export const _magicStringSignerRefused = seal({
	mode: 'local-keygen',
	// @ts-expect-error — signer is a direct account member ref, not a magic-string holder
	signer: { accountName: 'publisher' },
});

// @ts-expect-error — local-keygen is absent on fork-mode namespaces
export const _forkLocalKeygenRefused = sealFor.for(forkNet).localKeygen({ signer: publisher });

type NoManagerTagConstructor = typeof SealPublic extends { makeSealManagerTag: unknown }
	? never
	: true;
export const _noManagerTagConstructor: NoManagerTagConstructor = true;
