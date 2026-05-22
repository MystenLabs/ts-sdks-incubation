import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { generateEd25519Keypair } from '../../../src/plugins/account/keypair.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';
import { resolveEnvVariant } from '../../../src/plugins/account/variants/env.ts';
import { resolveInlineVariant } from '../../../src/plugins/account/variants/inline.ts';

const fakeResolvedAccount = {
	name: 'alice',
	address: '0xabc',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	signAndExecute: null,
	withTransactionSigner: null,
	signTransaction: null,
	signPersonalMessage: null,
} as unknown as AccountValue;

const fakeAcquireContext: AcquireContext = {
	identity: {
		app: appName('account-test'),
		stack: stackName('main'),
		chain: chainId('sui:local'),
	},
	chain: chainId('sui:local'),
	runtimeRoot: '/tmp/devstack-account-test',
};

const registryFundingFor = (member: ReturnType<typeof account>) => {
	if (typeof member.capabilities !== 'function') {
		throw new Error('expected account capabilities factory');
	}
	const decls = member.capabilities(fakeResolvedAccount, fakeAcquireContext);
	const registry = decls.find(
		(decl) =>
			decl.kind === 'strategy-contributor' &&
			decl.capabilityKey.startsWith('account:') &&
			'funding' in decl.strategy,
	);
	if (registry === undefined) throw new Error('missing account registry contribution');
	if (registry.kind !== 'strategy-contributor') throw new Error('missing account strategy');
	return registry.strategy.funding;
};

describe('account env and private-key variant surface', () => {
	it('env variant reads the public `key` option as the process env var name', async () => {
		const generated = await Effect.runPromise(generateEd25519Keypair('alice'));
		const envKey = `DEVSTACK_TEST_ALICE_${Date.now()}`;
		process.env[envKey] = generated.bech32Secret ?? '';
		try {
			const resolved = await Effect.runPromise(
				resolveEnvVariant({ name: 'alice', varName: envKey }),
			);
			expect(resolved.address).toBe(generated.address);
		} finally {
			delete process.env[envKey];
		}
	});

	it('env variant reports the missing public `key` option in typed errors', async () => {
		const envKey = `DEVSTACK_TEST_MISSING_${Date.now()}`;
		delete process.env[envKey];

		const exit = await Effect.runPromiseExit(resolveEnvVariant({ name: 'alice', varName: envKey }));

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('AccountAcquireError');
			expect(err.value.phase).toBe('read-env');
			expect(err.value.variant).toBe('env');
			expect(err.value.message).toContain(envKey);
		}
	});

	it('inline variant accepts the public privateKey field', async () => {
		const generated = await Effect.runPromise(generateEd25519Keypair('carol'));
		const resolved = await Effect.runPromise(
			resolveInlineVariant({ name: 'carol', privateKey: generated.bech32Secret ?? '' }),
		);

		expect(resolved.address).toBe(generated.address);
	});

	it('account factory accepts env key and inline privateKey option names', () => {
		const envAccount = account('prod', {
			kind: 'env',
			name: 'prod',
			key: 'ALICE_PRIVATE_KEY',
		});
		const inlineAccount = account('demo', {
			kind: 'inline',
			name: 'demo',
			privateKey: 'suiprivkey1demo',
		});

		expect(envAccount.id).toBe('account/prod');
		expect(inlineAccount.id).toBe('account/demo');
	});

	it('projects default ephemeral funding into account registry capabilities', () => {
		expect(registryFundingFor(account('alice'))).toEqual({
			status: 'funded',
			balanceMist: null,
			requestedMist: '1000000000',
		});
	});

	it('projects explicit zero default funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'ephemeral', name: 'alice', fund: 0n })),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: '0',
		});
	});

	it('projects non-ephemeral accounts without funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'env', name: 'alice', key: 'ALICE_KEY' })),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: null,
		});
	});
});
