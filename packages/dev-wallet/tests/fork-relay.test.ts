// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit coverage for the `ForkRelay` HTTP client + the manifest helper.
// Pure logic — no DOM, no Lit. Runs under the standard node-env
// vitest config alongside the rest of the adapter tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createForkRelayFromManifest, ForkRelay } from '../src/adapters/fork-relay.js';
import { DEVSTACK_WALLET_HTTP_PATH } from '../src/adapters/devstack-paths.js';

const ORIGIN = 'http://127.0.0.1:9420';

describe('ForkRelay constructor', () => {
	it('rejects malformed serverOrigin', () => {
		expect(() => new ForkRelay({ serverOrigin: 'not a url' })).toThrow(/invalid serverOrigin/i);
	});

	it('exposes serverOrigin verbatim', () => {
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		expect(relay.serverOrigin).toBe(ORIGIN);
	});
});

describe('ForkRelay.getStatus', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('parses checkpoint + clockMs as bigints', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					checkpoint: '42',
					clockMs: '1717171717171',
					autoTickMs: 1000,
					upstream: 'mainnet',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN, token: 'abc' });
		const result = await relay.getStatus();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.checkpoint).toBe(42n);
			expect(result.value.clockMs).toBe(1717171717171n);
			expect(result.value.autoTickMs).toBe(1000);
			expect(result.value.upstream).toBe('mainnet');
		}
		expect(fetchSpy).toHaveBeenCalledWith(
			`${ORIGIN}${DEVSTACK_WALLET_HTTP_PATH.FORK_STATUS}`,
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({
					Authorization: 'Bearer abc',
				}),
			}),
		);
	});

	it('returns ok:false with status on HTTP errors', async () => {
		fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.getStatus();
		expect(result).toEqual({ ok: false, error: 'boom', status: 500 });
	});

	it('returns ok:false on malformed JSON body', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ checkpoint: 5 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.getStatus();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/malformed/i);
	});

	it('returns ok:false on fetch rejection', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('refused'));
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.getStatus();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/refused/);
	});
});

describe('ForkRelay.advanceClock', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects non-positive integers without touching the network', async () => {
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const a = await relay.advanceClock(0);
		const b = await relay.advanceClock(-5);
		const c = await relay.advanceClock(1.5);
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(false);
		expect(c.ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('POSTs durationMs in the body and parses status response', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ checkpoint: '100', clockMs: '5000' }), { status: 200 }),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.advanceClock(60_000);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			`${ORIGIN}${DEVSTACK_WALLET_HTTP_PATH.FORK_ADVANCE_CLOCK}`,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ durationMs: 60_000 }),
			}),
		);
	});
});

describe('ForkRelay.advanceCheckpoint', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs count in the body', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ checkpoint: '5', clockMs: '0' }), { status: 200 }),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.advanceCheckpoint(3);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			`${ORIGIN}${DEVSTACK_WALLET_HTTP_PATH.FORK_ADVANCE_CHECKPOINT}`,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ count: 3 }),
			}),
		);
	});
});

describe('ForkRelay impersonations', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('listImpersonations parses slot array', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					slots: [
						{ address: '0xaa', label: 'whale', active: false },
						{ address: '0xbb', active: true },
					],
				}),
				{ status: 200 },
			),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.listImpersonations();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(2);
			expect(result.value[0]).toMatchObject({ address: '0xaa', label: 'whale', active: false });
			expect(result.value[1]).toMatchObject({ address: '0xbb', active: true });
		}
	});

	it('setImpersonation posts address+active and parses new slot list', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					slots: [{ address: '0xaa', active: true }],
				}),
				{ status: 200 },
			),
		);
		const relay = new ForkRelay({ serverOrigin: ORIGIN });
		const result = await relay.setImpersonation('0xaa', true);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			`${ORIGIN}${DEVSTACK_WALLET_HTTP_PATH.FORK_IMPERSONATIONS}`,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ address: '0xaa', active: true }),
			}),
		);
	});
});

describe('createForkRelayFromManifest', () => {
	it('returns null for bundled-mode manifests', () => {
		const relay = createForkRelayFromManifest({
			meta: { runtime: 'bundled' },
			app: { wallet: { url: ORIGIN } },
		});
		expect(relay).toBeNull();
	});

	it('returns null when no wallet endpoint is present', () => {
		const relay = createForkRelayFromManifest({
			meta: { runtime: 'forked' },
		});
		expect(relay).toBeNull();
	});

	it('builds a ForkRelay when fork-mode + wallet endpoint exist', () => {
		const relay = createForkRelayFromManifest({
			meta: { runtime: 'forked' },
			app: { wallet: { url: ORIGIN, pairUrl: `${ORIGIN}/pair#token=zeta` } },
		});
		expect(relay).toBeInstanceOf(ForkRelay);
	});

	it('treats `<redacted>` pairUrl tokens as absent', () => {
		const relay = createForkRelayFromManifest({
			meta: { runtime: 'forked' },
			app: { wallet: { url: ORIGIN, pairUrl: `${ORIGIN}/pair#token=<redacted>` } },
		});
		expect(relay).toBeInstanceOf(ForkRelay);
	});

	it('returns null on malformed wallet URL rather than throwing', () => {
		const relay = createForkRelayFromManifest({
			meta: { runtime: 'forked' },
			app: { wallet: { url: 'not a url' } },
		});
		expect(relay).toBeNull();
	});
});
