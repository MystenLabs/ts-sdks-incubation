// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	BaseError,
	ContractFunctionExecutionError,
	ContractFunctionRevertedError,
	parseAbi,
	UserRejectedRequestError,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import { describeError, WalletNetworkError } from '../../src/utils/errors.js';

const chains = getChainRegistry('mainnet');
const chain = (key: string) => chains.find((c) => c.key === key)!;
const abi = parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)']);

/** What viem throws when a claim is turned away: the reason, then the whole call. */
function claimFailed(reason: string) {
	return new ContractFunctionExecutionError(
		new ContractFunctionRevertedError({ abi, functionName: 'receiveMessage', message: reason }),
		{
			abi,
			functionName: 'receiveMessage',
			args: [`0x${'00'.repeat(376)}`, `0x${'2c'.repeat(130)}`],
			contractAddress: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
			sender: '0x12543552eEc2Fc00d9164f83933b2843d1565a98',
		},
	);
}

describe('putting an error into words', () => {
	it('says the wallet is out of gas, and what to add where', () => {
		// As shown on a card in production: 1,400 characters, most of them call data.
		const error = claimFailed(
			'RPC 0x2105 Infura eth_sendRawTransaction: gas required exceeds allowance (0)',
		);
		expect(error.message.length).toBeGreaterThan(1_000);
		expect(describeError(error, { chain: chain('base') })).toBe(
			'The wallet does not have enough ETH on Base to pay for gas. Add some ETH on Base, then try again.',
		);
		// Other ways of saying it, from other nodes and other chains.
		expect(
			describeError(new Error('insufficient funds for gas * price + value'), {
				chain: chain('avalanche'),
			}),
		).toMatch(/enough AVAX on Avalanche/);
		expect(
			describeError(
				new Error('Attempt to debit an account but found no record of a prior credit.'),
				{ chain: chain('solana') },
			),
		).toMatch(/enough SOL on Solana/);
		expect(
			describeError(new Error('No valid gas coins found for the transaction.'), {
				chain: chain('sui'),
			}),
		).toMatch(/enough SUI on Sui/);
		expect(describeError(new Error('insufficient funds'))).toBe(
			'The wallet does not have enough of the network coin to pay for gas.',
		);
	});

	it('says the request was rejected only when the wallet says the user did it', () => {
		expect(
			describeError(
				new UserRejectedRequestError(
					new Error('MetaMask Tx Signature: User denied transaction signature.'),
				),
			),
		).toBe('The request was rejected in the wallet.');
		expect(describeError(new Error('User rejected the request.'))).toBe(
			'The request was rejected in the wallet.',
		);
		// A wallet with no method for what was asked, filed by the library under "rejected".
		expect(describeError(new UserRejectedRequestError(new Error('Method not found')))).toBe(
			'The wallet turned the request down: Method not found',
		);
	});

	it("keeps to the library's one-line summary for anything else", () => {
		const said = describeError(claimFailed('Nonce already used'), { chain: chain('base') });
		expect(said).toBe(
			'The contract function "receiveMessage" reverted with the following reason: Nonce already used',
		);
		expect(describeError(new BaseError('The request took too long to respond.'))).toBe(
			'The request took too long to respond.',
		);
	});

	it("leaves the kit's own messages as they are", () => {
		const own =
			'Your wallet is on another network. Switch it to Base in the wallet, then try again.';
		expect(describeError(new WalletNetworkError(own))).toBe(own);
		expect(
			describeError(
				new Error('Not enough USDC on Solana: the wallet holds 0 and this transfer needs 0.5.'),
			),
		).toBe('Not enough USDC on Solana: the wallet holds 0 and this transfer needs 0.5.');
	});

	it('never hands back a wall of text', () => {
		const said = describeError(
			new Error(`Simulation failed.\n\n  data: 0x${'ab'.repeat(400)}\n${'x '.repeat(400)}`),
		);
		expect(said.length).toBeLessThanOrEqual(300);
		expect(said).toContain('0xabababab…ababab');
		expect(said).not.toContain('\n');
		expect(describeError('plain string')).toBe('plain string');
	});
});
