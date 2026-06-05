import { Effect } from 'effect';

import { defineDevstack } from '../../../src/api/define-devstack.ts';
import { definePlugin } from '../../../src/api/define-plugin.ts';

const leaf = definePlugin({
	id: 'test/config-loader-leaf',
	role: 'service',
	section: 'service',
	start: () => Effect.succeed({ ok: true } as const),
});

export default defineDevstack({
	members: [leaf],
	stackName: 'config-loader-fixture',
	stateDir: '.fixture-devstack-state',
});
