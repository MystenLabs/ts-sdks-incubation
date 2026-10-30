// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MESSAGE_V2 } from '../../src/utils/bytes.js';

/**
 * A v2 burn message of the bytes in `fill`, with the fields the kit reads out of it set. A message
 * of one repeated byte has a fee as large as its amount, and so nets nothing.
 */
export function burnMessage(
	options: { amount?: bigint; feeExecuted?: bigint; expiry?: bigint; fill?: number } = {},
): `0x${string}` {
	const { amount = 1_000_000n, feeExecuted = 0n, expiry = 0n, fill = 0xaa } = options;
	const { bodyFields } = MESSAGE_V2;
	const bytes = new Uint8Array(MESSAGE_V2.body + bodyFields.hookData).fill(fill);
	const view = new DataView(bytes.buffer);
	const setWord = (field: number, value: bigint) => {
		const at = MESSAGE_V2.body + field;
		bytes.fill(0, at, at + 32);
		view.setBigUint64(at + 24, value);
	};
	setWord(bodyFields.amount, amount);
	setWord(bodyFields.feeExecuted, feeExecuted);
	setWord(bodyFields.expirationBlock, expiry);
	return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
