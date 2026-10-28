// The sui member's input identity folds the EFFECTIVE sui-tools ref, so a
// changed env override marks snapshots stale like a config change would.

import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';

import { Effect } from 'effect';

import { sui, suiInputIdentity } from '../../../src/plugins/sui/index.ts';
import {
	computeLiveConfigId,
	computeStackGraphInputIdentity,
} from '../../../src/substrate/runtime/lifecycle/graph-input-id.ts';
import { SUI_TOOLS_REF_ENV_VAR } from '../../../src/plugins/sui/move/index.ts';

const identity = (opts: Parameters<typeof suiInputIdentity>[0]) =>
	JSON.stringify(suiInputIdentity(opts));

beforeEach(() => {
	vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('suiInputIdentity and the sui-tools ref', () => {
	it('is unchanged for a default stack with no ref anywhere', () => {
		const before = identity({ mode: 'local' });
		expect(before).not.toContain('suiToolsRef');
		expect(identity({ mode: 'fork', upstream: 'testnet' })).not.toContain('suiToolsRef');
	});

	it('changes when the env ref is set, in both container modes', () => {
		const local = identity({ mode: 'local' });
		const fork = identity({ mode: 'fork', upstream: 'testnet' });
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'local' })).not.toBe(local);
		expect(identity({ mode: 'fork', upstream: 'testnet' })).not.toBe(fork);
		// Config and env naming the same ref are the same identity.
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
		expect(identity({ mode: 'local', suiToolsRef: 'from-env' })).toBe(
			(vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env'), identity({ mode: 'local' })),
		);
	});

	it('ignores the env ref when image.pull names the whole image', () => {
		const pulled = identity({ mode: 'local', image: { pull: 'me/sui:1' } });
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'local', image: { pull: 'me/sui:1' } })).toBe(pulled);
	});

	it('never carries a ref for modes without a container', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'live', network: 'testnet' })).not.toContain('from-env');
	});
});

describe('suiInputIdentity and graphqlHeaders', () => {
	it('ignores graphqlHeaders, so rotating a token keeps snapshots valid', () => {
		const live = {
			mode: 'live',
			network: 'custom',
			rpcUrl: 'https://rpc.example',
			graphqlUrl: 'https://graphql.example/graphql',
		} as const;
		const bare = identity(live);
		const withToken = identity({ ...live, graphqlHeaders: { authorization: 'Bearer one' } });
		const rotated = identity({ ...live, graphqlHeaders: { authorization: 'Bearer two' } });
		expect(withToken).toBe(bare);
		expect(rotated).toBe(bare);
		expect(withToken).not.toContain('Bearer');

		const localRpc = { mode: 'local-rpc', rpcUrl: 'http://127.0.0.1:9000' } as const;
		expect(identity({ ...localRpc, graphqlHeaders: { 'x-api-key': 'k' } })).toBe(
			identity(localRpc),
		);
	});

	it('still changes when the GraphQL endpoint itself changes', () => {
		const live = { mode: 'live', network: 'custom', rpcUrl: 'https://rpc.example' } as const;
		expect(identity({ ...live, graphqlUrl: 'https://a.example/graphql' })).not.toBe(
			identity({ ...live, graphqlUrl: 'https://b.example/graphql' }),
		);
	});
});

describe('sui runtime input identity through the real factory', () => {
	// Drives `sui()` → `definePlugin` → graph identity, so dropping the
	// `runtimeInputIdentity` wiring (or its passthrough) fails here, not just
	// the fake-member hashing tests.
	const idsFor = (graphqlHeaders?: Readonly<Record<string, string>>) => {
		const plugin = sui({
			mode: 'live',
			network: 'custom',
			rpcUrl: 'https://rpc.example',
			graphqlUrl: 'https://graphql.example/graphql',
			...(graphqlHeaders === undefined ? {} : { graphqlHeaders }),
		});
		const members = [plugin];
		return computeStackGraphInputIdentity({
			stack: { members, options: {} },
			devstackVersion: '1.0.0',
		}).pipe(
			Effect.map(({ graphInputId }) => ({
				graphInputId,
				liveConfigId: computeLiveConfigId({ members, graphInputId }),
			})),
			Effect.orDie,
		);
	};

	it.effect('carries graphqlHeaders into the live-config id but not the graph id', () =>
		Effect.gen(function* () {
			const bare = yield* idsFor();
			const one = yield* idsFor({ authorization: 'Bearer one' });
			const rotated = yield* idsFor({ authorization: 'Bearer two' });
			expect(one.graphInputId).toBe(bare.graphInputId);
			expect(rotated.graphInputId).toBe(bare.graphInputId);
			expect(one.liveConfigId).not.toBe(bare.liveConfigId);
			expect(rotated.liveConfigId).not.toBe(one.liveConfigId);
		}),
	);

	it('declares no runtime inputs for modes without credentials', () => {
		expect(sui({ mode: 'local' }).runtimeInputIdentity).toBeUndefined();
		expect(
			sui({ mode: 'live', network: 'custom', rpcUrl: 'https://rpc.example' }).runtimeInputIdentity,
		).toBeUndefined();
	});
});
