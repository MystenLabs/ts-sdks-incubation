// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// Deposit addresses on testnet: send USDC to an address on Base Sepolia or Solana devnet, from any
// wallet, and it arrives on Sui. The claimer (MystenLabs/cctpv2-claimer) processes the deposit and
// claims it on Sui; run it locally with `SUI_NETWORK=testnet pnpm serve`.
//
//   VITE_CLAIMER_URL   the claimer's origin (default http://localhost:8787)
//   ?recovery=optional|required   ask for a recovery address (default: Sui-only addresses)
//   ?only                         deposit addresses only, with no wallet tab
import { createDAppKit } from '@mysten/dapp-kit-core';
import '@mysten/dapp-kit-core/web';
import { createCctpKit } from '@mysten-incubation/cctp-kit';
import '@mysten-incubation/cctp-kit/web';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const claimer = import.meta.env.VITE_CLAIMER_URL || 'http://localhost:8787';
const recovery = new URLSearchParams(location.search).get('recovery');

const dAppKit = createDAppKit({
	networks: ['testnet'],
	defaultNetwork: 'testnet',
	createClient: (network) =>
		new SuiGrpcClient({ network, baseUrl: `https://fullnode.${network}.sui.io:443` }),
	enableBurnerWallet: import.meta.env.VITE_ENABLE_BURNER_WALLET === 'true',
});

const kit = createCctpKit({
	dAppKit,
	network: 'testnet',
	direction: 'inflow',
	chains: { from: { allow: ['base', 'solana'] } },
	sponsor: { baseUrl: claimer },
	deposit: {
		baseUrl: claimer,
		recovery: recovery === 'optional' || recovery === 'required' ? recovery : 'none',
		defaultOpen: true,
		only: new URLSearchParams(location.search).has('only'),
	},
	ui: { title: 'Deposit USDC to Sui' },
});

document.querySelector('mysten-dapp-kit-connect-button')!.instance = dAppKit;
document.querySelector('mysten-cctp-bridge')!.instance = kit;
