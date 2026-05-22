import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { toCurrentEngineStack } from '../adapter.ts';
import type { AnyPlugin, CapabilityRoutingReport, DevstackStack } from '../core.ts';
import { account, defineDevstack, hostService } from '../builtins.ts';
import { adapterBehaviorStack, duplicateAliceConsumes } from './adapter-behavior.config.ts';
import { capabilityRouting } from './capability-sink.ts';
import { customPluginStack } from './custom-plugin.config.ts';
import { modeNarrowedStack } from './mode-narrowed.config.ts';
import { walletAllStack } from './wallet-all.config.ts';

const resolveStack = async (
	stack: DevstackStack<readonly AnyPlugin[]>,
): Promise<Map<string, unknown>> => {
	const values = new Map<string, unknown>();

	for (const member of toCurrentEngineStack(stack).members) {
		const value = await Effect.runPromise(
			member.acquire({
				get: (tag) => {
					assert(values.has(tag.id), `missing resolved value for ${tag.id}`);
					return values.get(tag.id) as never;
				},
			}) as Effect.Effect<unknown>,
		);
		values.set(member.provides.id, value);
	}

	return values;
};

export const runRuntimeSmoke = async (): Promise<void> => {
	assert.deepEqual(duplicateAliceConsumes, ['sui', 'account/alice']);

	const runtimeAlice = account('runtime-duplicate-alice');
	const runtimeAliceDuplicate = account('runtime-duplicate-alice');
	const appUsingRuntimeAlice = hostService({
		name: 'uses-runtime-alice',
		command: 'pnpm dev',
		port: 5221,
		dependsOn: runtimeAlice,
	});
	const appUsingRuntimeAliceDuplicate = hostService({
		name: 'uses-runtime-alice-duplicate',
		command: 'pnpm dev',
		port: 5222,
		dependsOn: runtimeAliceDuplicate,
	});
	const defineRuntimeStack = defineDevstack as (config: {
		readonly members: readonly AnyPlugin[];
	}) => unknown;
	assert.throws(
		() =>
			defineRuntimeStack({
				members: [appUsingRuntimeAlice, appUsingRuntimeAliceDuplicate],
			}),
		/Duplicate devstack provider for account\/runtime-duplicate-alice/,
	);

	const customValues = await resolveStack(customPluginStack);
	const cacheBackedApp = customValues.get('host-service/cache-backed-app') as {
		readonly env: Readonly<Record<string, string>>;
	};
	assert.equal(cacheBackedApp.env.REDIS_URL, 'redis://127.0.0.1:6379/cache');
	assert.equal(cacheBackedApp.env.CACHE_WARMED, 'true');

	const walletValues = await resolveStack(walletAllStack);
	const wallet = walletValues.get('wallet') as {
		readonly accounts: readonly unknown[];
	};
	assert.equal(wallet.accounts.length, 2);

	const duplicateValues = await resolveStack(adapterBehaviorStack);
	const duplicateAction = duplicateValues.get('action:arena.duplicateAlice') as {
		readonly name: string;
		readonly digest: string;
	};
	assert.equal(duplicateAction.name, 'arena.duplicateAlice');
	assert.equal(duplicateAction.digest, 'digest_arena.duplicateAlice');

	assert.equal(modeNarrowedStack.options.network?.mode, 'local');
	assert.deepEqual(
		toCurrentEngineStack(modeNarrowedStack).members.map((member) => member.provides.id),
		['host-service/local-indexer'],
	);

	const routed = await Effect.runPromise(
		capabilityRouting as Effect.Effect<CapabilityRoutingReport, unknown, never>,
	);
	assert.deepEqual(
		routed.handled.map((capability) => capability.kind),
		['health-check'],
	);
	assert.deepEqual(
		routed.unhandled.map((capability) => capability.kind),
		['third-party-observer'],
	);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runRuntimeSmoke();
}
