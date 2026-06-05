import { account, dashboard, defineDevstack, type Stack, sui } from '@mysten-incubation/devstack';

// Minimal stack for exercising the web dashboard: a local Sui node, a couple of
// funded accounts, and the dashboard plugin. No Move packages / codegen, so it
// boots fast and stays up for poking at the dashboard.
const stack: Stack = defineDevstack({
	members: [sui(), account('alice'), account('bob'), dashboard()],
	stackName: 'dashboard-demo',
});

export default stack;
