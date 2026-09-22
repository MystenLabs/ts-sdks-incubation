// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTED_APPS_STORAGE_KEY, ConnectedAppsStore } from '../src/client/connected-apps.js';

const app = (origin: string, connectedAt: number) => ({
	origin,
	name: origin,
	accounts: ['0x1'],
	connectedAt,
});

describe('ConnectedAppsStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('pins the storage key', () => {
		expect(CONNECTED_APPS_STORAGE_KEY).toBe('dev-wallet:connected-apps:v1');
	});

	it('round-trips apps, newest first, one entry per origin', () => {
		const store = new ConnectedAppsStore();
		store.record(app('https://a.example', 1));
		store.record(app('https://b.example', 2));
		store.record(app('https://a.example', 3));

		expect(new ConnectedAppsStore().list().map((a) => [a.origin, a.connectedAt])).toEqual([
			['https://a.example', 3],
			['https://b.example', 2],
		]);
	});

	it('removes an app', () => {
		const store = new ConnectedAppsStore();
		store.record(app('https://a.example', 1));
		store.remove('https://a.example');
		expect(store.has('https://a.example')).toBe(false);
	});

	it('treats invalid data as empty with a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem(CONNECTED_APPS_STORAGE_KEY, JSON.stringify([{ origin: 1 }]));
		expect(new ConnectedAppsStore().list()).toEqual([]);
		expect(warn).toHaveBeenCalled();
	});
});
