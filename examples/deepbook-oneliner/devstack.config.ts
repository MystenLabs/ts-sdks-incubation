// Minimal "one-liner" DeepBook DeX.
//
// The entire DeepBook + Pyth Move-vendoring + pool-wiring burden lives inside
// the `deepbook()` plugin: no `move/vendor/` tree, no `localPackage(...)`
// declarations, no hand-written pool/seed/feed config. `deepbook()` with no
// args publishes the BUNDLED DeepBook + sandbox-Pyth sources, provisions an
// ephemeral funded publisher, and creates a seeded default DEEP/SUI pool.

import { dashboard, deepbook, defineDevstack, sui, type Stack } from '@mysten-incubation/devstack';

const stack: Stack = defineDevstack({
	members: [sui(), deepbook(), dashboard()],
	stackName: 'deepbook-oneliner',
});

export default stack;
