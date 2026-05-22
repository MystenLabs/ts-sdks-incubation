import { action, defineDevstack } from '../builtins.ts';
import { toCurrentEngineStack } from '../adapter.ts';
import { alice } from './arena.config.ts';

export const duplicateAliceAction = action('arena.duplicateAlice', {
	dependsOn: { primary: alice, secondary: alice },
	body: (ctx, { primary, secondary }) =>
		ctx.signAndExecute(primary, (tx) => {
			tx.moveCall({ target: `${secondary.address}::debug::duplicate_dependency_shape` });
		}),
});

export const adapterBehaviorStack = defineDevstack({
	members: [duplicateAliceAction],
	stackName: 'adapter-behavior',
});

const adapterBehaviorEngineStack = toCurrentEngineStack(adapterBehaviorStack);

export const duplicateAliceConsumes = adapterBehaviorEngineStack.members
	.find((member) => member.provides.id === 'action:arena.duplicateAlice')
	?.consumes.map((dependency) => dependency.id);
