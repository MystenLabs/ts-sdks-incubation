import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { coin } from '../../../src/plugins/coin/index.ts';
import { DEEPBOOK_TESTNET_DEEP_COIN_TYPE, deepbook } from '../../../src/plugins/deepbook/index.ts';
import { generateEd25519Keypair } from '../../../src/plugins/account/keypair.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';
import { resolveEnvVariant } from '../../../src/plugins/account/variants/env.ts';
import { resolveEphemeralVariant } from '../../../src/plugins/account/variants/ephemeral.ts';
import { resolveInlineVariant } from '../../../src/plugins/account/variants/inline.ts';

const fakeResolvedAccount = {
	name: 'alice',
	address: '0xabc',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	funding: {
		requested: [{ coin: 'SUI', fullCoinType: '0x2::sui::SUI', amount: 1_000_000_000n }],
		applied: [{ coin: 'SUI', fullCoinType: '0x2::sui::SUI', amount: 1_000_000_000n }],
	},
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

const registryFundingFor = (
	member: ReturnType<typeof account>,
	funding: AccountValue['funding'] = fakeResolvedAccount.funding,
) => {
	if (typeof member.capabilities !== 'function') {
		throw new Error('expected account capabilities factory');
	}
	const decls = member.capabilities({ ...fakeResolvedAccount, funding }, fakeAcquireContext);
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
			key: 'ALICE_PRIVATE_KEY',
		});
		const inlineAccount = account('demo', {
			kind: 'inline',
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
			entries: [
				{
					coin: 'SUI',
					fullCoinType: '0x2::sui::SUI',
					amount: '1000000000',
					status: 'funded',
				},
			],
		});
	});

	it('projects explicit empty funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'ephemeral', funding: [] }), {
				requested: [],
				applied: [],
			}),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: null,
			entries: [],
		});
	});

	it('projects non-ephemeral accounts without funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'env', key: 'ALICE_KEY' }), {
				requested: [],
				applied: [],
			}),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: null,
			entries: [],
		});
	});

	it('threads funding coin and strategy provider refs into dependencies', () => {
		const deep = coin.known(DEEPBOOK_TESTNET_DEEP_COIN_TYPE);
		const dex = deepbook({ mode: 'known', network: 'testnet' });
		const member = account('alice', {
			kind: 'ephemeral',
			funding: [
				{ coin: 'sui', amount: 1_000_000_000n },
				{ coin: deep, amount: 15_000_000n, via: dex },
			],
		});

		expect(member.dependsOn.map((dependency) => dependency.id)).toEqual(['sui', deep.id, dex.id]);
	});
});

describe('account ephemeral variant persistence', () => {
	it('reuses the persisted keypair on warm start', async () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-account-ephemeral-'));
		const secretFilePath = join(root, 'account', 'alice.key');

		const first = await Effect.runPromise(
			resolveEphemeralVariant({ name: 'alice', secretFilePath }),
		);
		const second = await Effect.runPromise(
			resolveEphemeralVariant({ name: 'alice', secretFilePath }),
		);

		expect(second.address).toBe(first.address);
		expect(readFileSync(secretFilePath, 'utf8').trim()).toBe(first.bech32Secret);
		expect(statSync(secretFilePath).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, 'account')).mode & 0o777).toBe(0o700);
	});

	it('collapses concurrent first acquires onto one persisted keypair', async () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-account-ephemeral-race-'));
		const secretFilePath = join(root, 'account', 'alice.key');

		const [first, second] = await Effect.runPromise(
			Effect.all(
				[
					resolveEphemeralVariant({ name: 'alice', secretFilePath }),
					resolveEphemeralVariant({ name: 'alice', secretFilePath }),
				],
				{ concurrency: 2 },
			),
		);

		expect(second.address).toBe(first.address);
		expect(readFileSync(secretFilePath, 'utf8').trim()).toBe(first.bech32Secret);
	});
});
