import {
	account,
	dashboard,
	defineDevstack,
	postgres,
	type Stack,
	sui,
} from '@mysten-incubation/devstack';

// Minimal stack for exercising the web dashboard: a local Sui node, a couple of
// funded accounts, a Postgres instance (so the Postgres panel has real data),
// and the dashboard plugin. No Move packages / codegen, so it boots fast and
// stays up for poking at the dashboard.
const stack: Stack = defineDevstack({
	members: [sui(), account('alice'), account('bob'), postgres(), dashboard()],
	stackName: 'dashboard-demo',
});

export default stack;
