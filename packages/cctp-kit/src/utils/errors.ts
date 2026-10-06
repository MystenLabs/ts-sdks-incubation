// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A transaction that definitely did not take effect: it was mined and reverted, or it can no
 * longer land. Nothing moved, so sending it again is safe.
 *
 * Anything else that goes wrong while waiting for a transaction (a timeout, an RPC outage) is
 * NOT this error: the transaction may still have gone through, and must not be sent again.
 */
export class TransactionRevertedError extends Error {
	override name = 'TransactionRevertedError';
}
