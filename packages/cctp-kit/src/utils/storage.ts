// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Minimal synchronous storage interface (compatible with `localStorage`). */
export interface StateStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export const DEFAULT_STORAGE_KEY = 'mysten-cctp-kit:transfers';

export function createInMemoryStorage(): StateStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
	};
}

export function getDefaultStorage(): StateStorage {
	try {
		if (typeof window !== 'undefined' && window.localStorage) {
			const probe = '__cctp_kit_probe__';
			window.localStorage.setItem(probe, '1');
			window.localStorage.removeItem(probe);
			return window.localStorage;
		}
	} catch {
		// Private mode or blocked storage.
	}
	return createInMemoryStorage();
}
