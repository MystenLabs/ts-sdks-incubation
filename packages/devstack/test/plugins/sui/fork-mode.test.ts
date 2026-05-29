import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';

import { chainId, type NetworkConfig } from '../../../src/substrate/index.ts';
import { sui, suiFor } from '../../../src/plugins/sui/index.ts';
import { DEFAULT_EPHEMERAL_FUND_MIST } from '../../../src/plugins/account/index.ts';
import {
	FORK_FAUCET_DEFAULT_FUND_MIST,
	FORK_FAUCET_WHALE_MIN_COIN_MIST,
	forkDataDirKey,
	forkStartCommand,
	resolveForkWhale,
	withForkFaucetSeed,
} from '../../../src/plugins/sui/mode/fork.ts';
import {
	buildForkImpersonationTransactionBytes,
	FORK_IMPERSONATION_GAS_BUDGET,
	verifyForkImpersonationSender,
} from '../../../src/plugins/sui/fork-transaction.ts';

const normalizedId = (id: string): string => `0x${id.replace(/^0x/i, '').padStart(64, '0')}`;

describe('sui fork mode', () => {
	it('constructs direct fork config', () => {
		expect(() => sui({ mode: 'fork', upstream: 'mainnet' })).not.toThrow();
	});

	it('constructs through the mode-narrowed fork factory', () => {
		const fork: NetworkConfig<'fork'> = {
			mode: 'fork',
			chain: chainId('sui:mainnet-fork'),
		};

		expect(() => suiFor(fork).mainnet()).not.toThrow();
	});

	it('builds the sui-fork start command with checkpoint and seed inputs', () => {
		expect(
			forkStartCommand({
				mode: 'fork',
				upstream: 'testnet',
				checkpoint: 123,
				seed: {
					addresses: ['0xabc'],
					objects: ['0xdef'],
				},
			}),
		).toEqual([
			'start',
			'--network',
			'testnet',
			'--data-dir',
			'/var/lib/sui-fork',
			'--rpc-addr',
			'0.0.0.0:9000',
			'--checkpoint',
			'123',
			'--address',
			normalizedId('0xabc'),
			'--object',
			normalizedId('0xdef'),
		]);
	});

	it('keys fork data directories by upstream checkpoint revision and sorted seed set', () => {
		const first = forkDataDirKey({
			mode: 'fork',
			upstream: 'testnet',
			checkpoint: 123,
			version: 'abc',
			seed: {
				addresses: ['0x2', '0x1'],
				objects: ['0xb', '0xa'],
			},
		});
		const same = forkDataDirKey({
			mode: 'fork',
			upstream: 'testnet',
			checkpoint: 123,
			version: 'abc',
			seed: {
				addresses: ['0x1', '0x2'],
				objects: ['0xa', '0xb'],
			},
		});
		const changed = forkDataDirKey({
			mode: 'fork',
			upstream: 'testnet',
			checkpoint: 124,
			version: 'abc',
			seed: {
				addresses: ['0x1', '0x2'],
				objects: ['0xa', '0xb'],
			},
		});

		expect(first).toBe(same);
		expect(first).not.toBe(changed);
	});

	it('canonicalizes seed ordering for both data dir keys and container commands', () => {
		const first = {
			mode: 'fork',
			upstream: 'testnet',
			checkpoint: 123,
			version: 'abc',
			seed: {
				addresses: ['0x2', '0x001', '0x1'],
				objects: ['0xb', '0x0A', '0xa'],
			},
		} as const;
		const same = {
			mode: 'fork',
			upstream: 'testnet',
			checkpoint: 123,
			version: 'abc',
			seed: {
				addresses: ['0x1', '0x2'],
				objects: ['0xa', '0xb'],
			},
		} as const;

		expect(forkDataDirKey(first)).toBe(forkDataDirKey(same));
		expect(forkStartCommand(first)).toEqual(forkStartCommand(same));
		expect(forkStartCommand(first)).toEqual(
			expect.arrayContaining([
				'--address',
				normalizedId('0x1'),
				'--address',
				normalizedId('0x2'),
				'--object',
				normalizedId('0xa'),
				'--object',
				normalizedId('0xb'),
			]),
		);
	});

	it('verifies fork impersonation transaction sender before submit', async () => {
		const alice = '0x1111111111111111111111111111111111111111111111111111111111111111';
		const bob = '0x2222222222222222222222222222222222222222222222222222222222222222';
		const tx = new Transaction();
		const bytes = await Effect.runPromise(
			buildForkImpersonationTransactionBytes(tx, alice, {
				getObject: () => Promise.reject(new Error('unused')),
				listCoins: () =>
					Promise.resolve({
						objects: [
							{
								objectId: '0x3333333333333333333333333333333333333333333333333333333333333333',
								version: '1',
								digest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
								balance: '1000000000',
							},
						],
					}),
			}),
		);

		await expect(
			Effect.runPromise(verifyForkImpersonationSender(alice, bytes)),
		).resolves.toBeUndefined();

		const exit = await Effect.runPromiseExit(verifyForkImpersonationSender(bob, bytes));
		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('SuiPluginError');
			expect(err.value.phase).toBe('fork-impersonate');
			expect(err.value.message).toContain('sender mismatch');
		}
	});

	it('fork impersonation stamps gas fields from the selected sender coin', async () => {
		const alice = '0x1111111111111111111111111111111111111111111111111111111111111111';
		const bob = '0x2222222222222222222222222222222222222222222222222222222222222222';
		const gasObjectId = '0x3333333333333333333333333333333333333333333333333333333333333333';
		const tx = new Transaction();
		tx.setGasOwner(bob);
		tx.setGasPayment([]);
		tx.setGasBudget(1n);
		tx.setGasPrice(1n);

		const bytes = await Effect.runPromise(
			buildForkImpersonationTransactionBytes(tx, alice, {
				getObject: () => Promise.reject(new Error('unused')),
				listCoins: () =>
					Promise.resolve({
						objects: [
							{
								objectId: gasObjectId,
								version: '7',
								digest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
								balance: '1000000000',
							},
						],
					}),
			}),
		);

		const data = TransactionDataBuilder.fromBytes(bytes).snapshot();
		expect(data.sender).toBe(alice);
		expect(data.gasData.owner).toBe(alice);
		expect(data.gasData.payment).toEqual([
			{
				objectId: gasObjectId,
				version: '7',
				digest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
			},
		]);
		expect(data.gasData.budget).toBe('100000000');
		expect(data.gasData.price).toBe('1000');
	});

	it('pins the fork faucet default fund to the account ephemeral fund', () => {
		// fork.ts mirrors the account plugin's DEFAULT_EPHEMERAL_FUND_MIST
		// locally (account → sui already, so importing it there would cycle).
		// This pins the two so drifting one without the other fails here.
		expect(FORK_FAUCET_DEFAULT_FUND_MIST).toBe(DEFAULT_EPHEMERAL_FUND_MIST);
	});

	it('sets the boot whale floor to the default fund plus the impersonation gas budget', () => {
		// The boot-time floor must equal the per-request requirement for the
		// default auto-fund, so a whale that passes boot can satisfy the first
		// ephemeral-account fund (fund + gas), not just the bare gas budget.
		expect(FORK_FAUCET_WHALE_MIN_COIN_MIST).toBe(
			FORK_FAUCET_DEFAULT_FUND_MIST + FORK_IMPERSONATION_GAS_BUDGET,
		);
	});

	it('resolves an explicit faucet whale (normalized) and flags it explicit', () => {
		const resolved = resolveForkWhale({
			mode: 'fork',
			upstream: 'testnet',
			faucet: { whale: '0xabc' },
		});
		expect(resolved).not.toBeNull();
		expect(resolved?.whale).toBe(normalizedId('0xabc'));
		expect(resolved?.explicit).toBe(true);
	});

	it('disables the faucet when explicitly turned off', () => {
		expect(
			resolveForkWhale({ mode: 'fork', upstream: 'testnet', faucet: { enabled: false, whale: '0xabc' } }),
		).toBeNull();
	});

	it('resolves the per-upstream default whale (non-explicit) when none is configured', () => {
		const resolved = resolveForkWhale({ mode: 'fork', upstream: 'testnet' });
		expect(resolved).not.toBeNull();
		expect(resolved?.explicit).toBe(false);
		// A normalized 32-byte address from FORK_DEFAULT_WHALE.
		expect(resolved?.whale).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('auto-injects the faucet whale into the fork seed + start command', () => {
		const seeded = withForkFaucetSeed({
			mode: 'fork',
			upstream: 'testnet',
			faucet: { whale: '0xabc' },
		});
		expect(seeded.seed?.addresses).toContain(normalizedId('0xabc'));
		expect(forkStartCommand(seeded)).toEqual(
			expect.arrayContaining(['--address', normalizedId('0xabc')]),
		);
	});

	it('keys a distinct fork data dir when the faucet whale changes', () => {
		const base = { mode: 'fork', upstream: 'testnet', checkpoint: 1 } as const;
		const withWhale = forkDataDirKey(
			withForkFaucetSeed({ ...base, faucet: { whale: '0xabc' } }),
		);
		const withOther = forkDataDirKey(
			withForkFaucetSeed({ ...base, faucet: { whale: '0xdef' } }),
		);
		const without = forkDataDirKey(base);
		expect(withWhale).not.toBe(without);
		expect(withWhale).not.toBe(withOther);
	});

	it('fork image includes the Sui CLI path used by package builds', () => {
		const dockerfile = readFileSync(
			resolve(import.meta.dirname, '../../../images/sui-fork/Dockerfile'),
			'utf8',
		);

		expect(dockerfile).toContain('cargo build --release -p sui-fork');
		expect(dockerfile).toContain('SUI_CLI_VERSION');
		expect(dockerfile).toContain('sui --version');
		expect(dockerfile).toContain('gawk git');
	});
});
