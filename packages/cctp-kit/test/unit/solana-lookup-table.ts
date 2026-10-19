// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AddressLookupTableAccount, Connection, PublicKey } from '@solana/web3.js';
import { vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';

/**
 * Circle's CCTP lookup table on Solana mainnet as it is on chain, read on 2026-10-19. It is
 * frozen, so these never change. Ten of a claim's accounts are in it.
 */
export const MAINNET_CCTP_LOOKUP_TABLE = new AddressLookupTableAccount({
	key: new PublicKey(SOLANA_MAINNET.cctpLookupTable),
	state: {
		deactivationSlot: 2n ** 64n - 1n,
		lastExtendedSlot: 0,
		lastExtendedSlotStartIndex: 0,
		authority: undefined,
		addresses: [
			'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
			'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
			'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
			'11111111111111111111111111111111',
			'AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W',
			'E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux',
			'W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU',
			'CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1',
			'6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L',
			'DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up',
			'6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd',
			'H1AL6KrVjbL3brz8YUd8MFiZ1vGmfi41HEDJq4LXvLjT',
		].map((address) => new PublicKey(address)),
	},
});

/**
 * Answer reads of Circle's lookup table with the mainnet one. `getAddressLookupTable` does not
 * go through `getAccountInfo`, so without this a test that builds a claim asks the network.
 */
export function solanaHasCctpLookupTable() {
	return vi.spyOn(Connection.prototype, 'getAddressLookupTable').mockResolvedValue({
		context: { slot: 1 },
		value: MAINNET_CCTP_LOOKUP_TABLE,
	});
}
