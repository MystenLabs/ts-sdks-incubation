// Committed devnet deployment for connect-four.
//
// A prod-style per-network deployment: the package id below was published to
// Sui devnet (`sui client test-publish move/connect_four --build-env devnet`).
// `satisfies AppNetworkDeployment` makes the shape exhaustive over this app's
// declared packages + MVR placeholders — a missing/typo'd id fails `tsc`. NO
// `accounts`: dev identities are network-agnostic and ride the runtime
// envelope, never the per-network authoring surface.
//
// connect-four creates its Lobby/Game objects at runtime (`create_lobby` /
// `join_lobby`), so there are no init objects to capture here — only the
// published package id.

import type { AppNetworkDeployment } from '../src/generated/deployment.js';

const CONNECT_FOUR_PACKAGE_ID =
	'0xca3763f3b9b94436b2964bc89a5384583a9cd99dfc2ad3d326483b75b9f7a846';

export const deployment = {
	network: 'devnet',
	rpc: 'https://fullnode.devnet.sui.io:443',
	chainId: '5ea2c653',
	faucet: null,
	graphql: null,
	packages: {
		connect_four: { id: CONNECT_FOUR_PACKAGE_ID },
	},
	mvrOverrides: {
		'@local/connect-four': CONNECT_FOUR_PACKAGE_ID,
	},
} satisfies AppNetworkDeployment;
