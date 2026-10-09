// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// What the form says about the destination before anything is burned. A transfer ends with a
// claim there, paid for there, and people found that out only after their burn.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import type { AnyDAppKit } from '../../src/core/types.js';
import { TOKEN_PROGRAM_ID } from '../../src/engine/solana.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';

const SUI_ADDRESS = `0x${'ab'.repeat(32)}`;
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const noWallet = (ecosystem: 'evm' | 'solana') => ({
	ecosystem,
	getAccount: () => null,
	subscribe: () => () => undefined,
	connect: async () => undefined,
	disconnect: async () => undefined,
});

/** A kit with a Sui wallet holding 5 USDC and `sui` of SUI; no EVM or Solana wallet. */
function kitWith(options: { sui?: string | Error; direction: 'inflow' | 'outflow'; to?: string }) {
	const getBalance = vi.fn(async ({ coinType }: { coinType: string }) => {
		if (coinType !== '0x2::sui::SUI') return { balance: { balance: '5000000' } };
		if (options.sui instanceof Error) throw options.sui;
		return { balance: { balance: options.sui ?? '1000000000' } };
	});
	return createCctpKit({
		dAppKit: {
			stores: {
				$connection: atom({ account: { address: SUI_ADDRESS } }),
				$currentNetwork: atom('mainnet'),
			},
			getClient: () => ({ core: { getBalance } }),
		} as unknown as AnyDAppKit,
		network: 'mainnet',
		direction: options.direction,
		defaults: options.to ? { to: options.to as never } : undefined,
		storage: createInMemoryStorage(),
		iris: {
			fetch: vi.fn<typeof fetch>(async () => json(400, { error: 'no quote in this test' })),
		},
		wallets: { evm: noWallet('evm') as never, solana: noWallet('solana') as never },
	});
}

describe('gas on the destination', () => {
	it('is warned about when the wallet that will claim holds none, and stops nothing', async () => {
		// Someone bringing USDC to Sui for the first time, with no SUI yet.
		const kit = kitWith({ direction: 'inflow', sui: '0' });
		await settle();
		expect(kit.warnings()).toEqual([
			'Your Sui wallet holds no SUI. You will need some to claim the USDC on Sui.',
		]);
		// The form's one reason for not going ahead is something else entirely.
		expect(kit.validate()).toMatch(/^Connect your \w+ wallet$/);
		kit.destroy();
	});

	it('is not mentioned when the wallet holds some, or its balance cannot be read', async () => {
		const funded = kitWith({ direction: 'inflow' });
		const unknown = kitWith({ direction: 'inflow', sui: new Error('node says no') });
		await settle();
		expect(funded.warnings()).toEqual([]);
		expect(unknown.warnings()).toEqual([]);
		funded.destroy();
		unknown.destroy();
	});
});

describe('a recipient typed by hand, with no wallet for that chain connected', () => {
	it('is told that the USDC has to be claimed, and with what', async () => {
		// An exchange deposit address, or a wallet on another device. Nobody there will claim.
		const kit = kitWith({ direction: 'outflow', to: 'avalanche' });
		expect(kit.warnings()).toEqual([]);
		kit.setRecipient(EVM_ADDRESS);
		await settle();
		expect(kit.warnings()).toEqual([
			'USDC does not arrive on Avalanche by itself. After the burn, it has to be claimed on Avalanche from a wallet that holds AVAX.',
		]);
		kit.destroy();
	});
});

describe('a Solana recipient typed by hand', () => {
	const owner = Keypair.generate().publicKey;
	const tokenAccount = (mint: string) => {
		const data = Buffer.alloc(165);
		new PublicKey(mint).toBuffer().copy(data, 0);
		owner.toBuffer().copy(data, 32);
		return { data, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID };
	};
	const pasted = Keypair.generate().publicKey.toBase58();
	const filled = (found: unknown) => {
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue(found as never);
		const kit = kitWith({ direction: 'outflow', to: 'solana' });
		kit.setAmount('1');
		kit.setRecipient(pasted);
		return kit;
	};

	it('is refused when it is a USDC token account, and the wallet that owns it is named', async () => {
		// A token account's address looks like a wallet's. Sending "to" it as if it were one
		// puts the USDC in an account nobody holds the key to.
		const kit = filled(tokenAccount(USDC_MINT));
		await settle();
		expect(kit.validate()).toBe(
			`That is a USDC token account, not a wallet. Enter the wallet that owns it: ${owner.toBase58()}`,
		);
		kit.destroy();
	});

	it('is refused when it is some other token account, a token or a program', async () => {
		const other = filled(tokenAccount(Keypair.generate().publicKey.toBase58()));
		await settle();
		expect(other.validate()).toBe(
			'That is a token account for another token, not a wallet address',
		);
		other.destroy();

		const mint = filled({
			data: Buffer.alloc(82),
			executable: false,
			lamports: 1,
			owner: TOKEN_PROGRAM_ID,
		});
		await settle();
		expect(mint.validate()).toBe('That address is a token or a program, not a wallet');
		mint.destroy();
	});

	it('is accepted when it is a wallet, when nothing is there yet, and when the chain cannot be asked', async () => {
		const reasons: (string | null)[] = [];
		for (const found of [
			{
				data: Buffer.alloc(0),
				executable: false,
				lamports: 1,
				owner: new PublicKey(new Uint8Array(32)),
			},
			null,
		]) {
			const kit = filled(found);
			await settle();
			reasons.push(kit.validate());
			kit.destroy();
		}
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockRejectedValue(new Error('403'));
		const kit = kitWith({ direction: 'outflow', to: 'solana' });
		kit.setAmount('1');
		kit.setRecipient(pasted);
		await settle();
		reasons.push(kit.validate());
		kit.destroy();
		// Whatever else the form still wants (a quote, here), it is not about the recipient.
		for (const reason of reasons) expect(reason ?? '').not.toMatch(/wallet|token|program/i);
	});
});
