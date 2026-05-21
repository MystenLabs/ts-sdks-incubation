import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { generateEd25519Keypair } from '../../../src/plugins/account/keypair.ts';
import { resolveEnvVariant } from '../../../src/plugins/account/variants/env.ts';
import { resolveInlineVariant } from '../../../src/plugins/account/variants/inline.ts';

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

		expect(envAccount.provides.id).toBe('account/prod');
		expect(inlineAccount.provides.id).toBe('account/demo');
	});
});
