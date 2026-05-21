// Repro for the wallet plugin's account-tag-literal-erasure bug, plus
// the matching negative cases.
//
// Bug (now fixed): `WalletAccountTag = Tag<AccountTagId<string>, AccountValue>`
// (non-generic) plus `consumes: [SuiTag, ...accountTags] as const`
// widened away each literal `account/${Name}` id at the call site.
// The wallet is now generic over the account-member tuple via
// `WalletAccountMember<Name>` so each literal tag id survives into the
// stack-composition `MissingProviders` check.

import { defineDevstack } from '../src/index.ts';
import { sui } from '../src/plugins/sui/index.ts';
import { account } from '../src/plugins/account/index.ts';
import { wallet } from '../src/plugins/wallet/index.ts';

const alice = account('alice');
const bob = account('bob');

// --- Positive case: every consumed account is composed -----------------

export const stack = defineDevstack(sui(), alice, bob, wallet({ accounts: [alice, bob] }), {
	stackName: 'wallet-typing',
});

// --- Negative case: wallet consumes `account/bob` but only `account/alice`
//     is composed. MissingProviders MUST surface `account/bob`. -------

export const missingAccount = defineDevstack(
	// @ts-expect-error — MissingProviders: 'account/bob' (no member provides it)
	sui(),
	alice,
	wallet({ accounts: [alice, bob] }),
	{ stackName: 'wallet-typing-missing' },
);
