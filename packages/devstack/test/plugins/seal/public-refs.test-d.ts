import { account } from '../../../src/plugins/account/index.ts';
import * as SealPublic from '../../../src/plugins/seal/index.ts';
import {
	seal,
	sealFor,
	type SealKeyManager,
	type SealResolved,
} from '../../../src/plugins/seal/index.ts';
import type { NetworkConfig } from '../../../src/plugins/sui/network-config.ts';
import type { ResourceValueOf } from '../../../src/substrate/plugin.ts';

const localNet: NetworkConfig<'local'> = { mode: 'local', chainId: 'sui:localnet' };
const liveNet: NetworkConfig<'live'> = { mode: 'live', chainId: 'sui:testnet' };
const mainnetNet: NetworkConfig<'live'> = { mode: 'live', chainId: 'sui:mainnet' };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chainId: 'sui:testnet-fork',
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

// Live mode: zero-config testnet (both independent servers), committee opt-in,
// and the verbatim serverConfigs override on `.custom`.
export const _liveTestnet = sealFor(liveNet).testnet();
export const _liveTestnetCommittee = sealFor(liveNet).testnet({ server: 'committee' });
export const _liveMainnetCommittee = sealFor(mainnetNet).mainnet({
	apiKey: 'k',
	apiKeyName: 'X-API-Key',
});
export const _liveCustom = sealFor(liveNet).custom({
	serverConfigs: [{ objectId: '0x1', weight: 1, aggregatorUrl: 'https://agg.example' }],
});

// `.custom` REQUIRES `serverConfigs` — omitting it is a compile error.
export const _customWithoutServerConfigsRefused = sealFor(liveNet).custom(
	// @ts-expect-error — serverConfigs is required on the verbatim override
	{},
);

// `server` is a closed 'independent' | 'committee' selector — a typo is refused.
export const _badServerKindRefused = sealFor(liveNet).testnet({
	// @ts-expect-error — 'aggregator' is not a SealServerKind
	server: 'aggregator',
});

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
