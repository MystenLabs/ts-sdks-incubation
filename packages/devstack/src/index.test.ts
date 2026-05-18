// Public-API surface contract. Imports every named value export from the
// root barrel and asserts the set matches a pinned list. Catches
// accidental removals or unintended additions to the package's public
// surface — when the surface changes intentionally, update PUBLIC_EXPORTS
// in this file and the test stays green.

import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';

const PUBLIC_EXPORTS = [
	// Compose entry
	'devstack',
	// Ref factories
	'Account',
	'Action',
	'Codegen',
	'DEFAULT_CODEGEN_OUTPUT',
	'Deepbook',
	'DeepbookMarketMaker',
	'Dev',
	'Faucet',
	'FaucetTag',
	'KnownPackage',
	'Package',
	'Seal',
	'Sui',
	'Wallet',
	'Walrus',
	// Runtime accessor
	'Devstack',
	'DevstackLive',
	'fromManifest',
	// Helpers
	'pickCreatedByTypeIncludes',
	'pickCreatedByTypeSuffix',
	'registerCoin',
	'knownDeployments',
	// Tagged error types
	'AccountError',
	'DeepbookError',
	'DockerError',
	'HostProcessError',
	'ManifestError',
	'PublishError',
	'SealError',
	'SuiError',
	'WalletAppError',
	'WalrusError',
	// Interface tag classes
	'CoinTag',
	'DeepbookCoreTag',
	'SealKeyServerTag',
	'WalrusNetworkTag',
	'WalrusNodesTag',
	'WalrusProxyTag',
] as const;

describe('public API surface', () => {
	it('exports exactly the pinned set of named values', () => {
		const actual = Object.keys(publicApi).sort();
		const expected = [...PUBLIC_EXPORTS].sort();
		expect(actual).toEqual(expected);
	});
});
