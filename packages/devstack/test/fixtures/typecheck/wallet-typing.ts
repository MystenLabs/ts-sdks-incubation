// Repro for the wallet plugin's account-resource-literal-erasure bug.
//
// Bug (now fixed): the wallet's account dependency typing widened
// away each literal `account/${Name}` id at the call site.
// The wallet is now generic over the account-member tuple via
// `WalletAccountMember<Name>` so each literal resource id survives into the
// recursive stack-composition dependency closure.

import { defineDevstack, sui } from '../../../src/index.ts';
import { account } from '../../../src/plugins/account/index.ts';
import { wallet } from '../../../src/plugins/wallet/index.ts';

const localnet = sui();
const alice = account('alice');
const bob = account('bob');

// The wallet is the entrypoint. Its explicit account plugin refs and
// the stack's explicit Sui provider satisfy the dependency closure.
export const stack = defineDevstack({
	members: [localnet, wallet({ accounts: [alice, bob] })],
	stackName: 'wallet-typing',
});
