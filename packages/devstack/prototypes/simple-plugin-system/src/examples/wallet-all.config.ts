import { toCurrentEngineStack } from '../adapter.ts';
import { WALLET_ACCOUNTS_ALL, defineDevstack, wallet } from '../builtins.ts';
import { alice, bob } from './arena.config.ts';

export const walletAllStack = defineDevstack({
	members: [alice, bob, wallet({ accounts: WALLET_ACCOUNTS_ALL })],
});

const walletAllEngineStack = toCurrentEngineStack(walletAllStack);
const walletMember = walletAllEngineStack.members.find(
	(member) => member.provides.id === 'wallet',
);
const walletConsumes = walletMember?.consumes.map((dependency) => dependency.id);

void walletConsumes;
