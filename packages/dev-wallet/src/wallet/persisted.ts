// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read a versioned JSON value from storage. A missing key is a plain miss;
 * unparseable data, or data `decode` rejects (returns `null`), is a miss plus
 * a warning, so a bad write never crashes the wallet.
 */
export function readPersisted<T>(
	storage: Storage,
	key: string,
	decode: (value: unknown) => T | null,
): T | null {
	const raw = storage.getItem(key);
	if (raw === null) return null;
	let value: T | null = null;
	try {
		value = decode(JSON.parse(raw));
	} catch {
		// Invalid JSON — handled below.
	}
	if (value === null) console.warn(`[dev-wallet] Ignoring invalid data in "${key}".`);
	return value;
}
