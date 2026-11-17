import type { SettlementClaim, SettlementGuard, SettlementKey } from './types.js';

type Entry = { network: string; maxEpoch: bigint; pending: boolean };

/**
 * In-process settlement guard. Successful and pending claims are kept as long
 * as {@link SettlementGuard} requires. Not shared across processes and lost on
 * restart: when several processes serve `/settle`, or settle may run without a
 * prior verify, supply a {@link SettlementGuard} backed by one shared, durable
 * store with atomic claims.
 */
export class SettlementCache implements SettlementGuard {
	private readonly entries = new Map<string, Entry>();
	private readonly latestEpoch = new Map<string, bigint>();

	/**
	 * Claim a key. The check and update are synchronous, so concurrent settles of
	 * the same transaction cannot both hold it.
	 *
	 * @param key - The settlement identity
	 * @returns The claim result
	 */
	claim(key: SettlementKey): SettlementClaim {
		const id = cacheKey(key);
		const entry = this.entries.get(id);
		if (entry && !entry.pending) return 'held';
		this.entries.set(id, { network: key.network, maxEpoch: BigInt(key.maxEpoch), pending: false });
		return entry ? 'pending' : 'claimed';
	}

	/**
	 * Mark a held key as pending, so the next claim reconciles it.
	 *
	 * @param key - The settlement identity
	 */
	markPending(key: SettlementKey): void {
		const entry = this.entries.get(cacheKey(key));
		if (entry) entry.pending = true;
	}

	/**
	 * Drop a claim so the transaction can be settled again.
	 *
	 * @param key - The settlement identity
	 */
	release(key: SettlementKey): void {
		this.entries.delete(cacheKey(key));
	}

	/**
	 * Record the network's current epoch, and drop claims that no longer need to
	 * be kept (see {@link SettlementGuard}).
	 *
	 * @param network - The CAIP-2 network id
	 * @param epoch - The current epoch reported by the network
	 */
	observeEpoch(network: string, epoch: string | bigint): void {
		const observed = BigInt(epoch);
		const previous = this.latestEpoch.get(network);
		if (previous !== undefined && observed <= previous) return;
		this.latestEpoch.set(network, observed);
		for (const [id, entry] of this.entries) {
			if (entry.network === network && entry.maxEpoch + 1n < observed) this.entries.delete(id);
		}
	}
}

/**
 * The map key for a settlement: network and digest.
 *
 * @param key - The settlement identity
 * @returns The map key
 */
function cacheKey(key: SettlementKey): string {
	return `${key.network}:${key.digest}`;
}
