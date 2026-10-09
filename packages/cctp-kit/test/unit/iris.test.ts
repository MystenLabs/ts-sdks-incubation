// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { IrisClient, IrisError } from '../../src/iris/client.js';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('IrisClient', () => {
	it('polls until the attestation is complete, treating 404 as pending', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse(404, { error: 'Message not found for provided parameters' }),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					messages: [
						{
							message: '0x',
							attestation: 'PENDING',
							eventNonce: '1',
							cctpVersion: 2,
							status: 'pending_confirmations',
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					messages: [
						{
							message: '0xabcd',
							attestation: '0x1234',
							eventNonce: '1',
							cctpVersion: 2,
							status: 'complete',
						},
					],
				}),
			);

		const client = new IrisClient('mainnet', { fetch: fetchMock });
		const pendingStates: unknown[] = [];
		const result = await client.waitForAttestation(8, 'digest', {
			intervalMs: 1,
			onPending: (m) => pendingStates.push(m),
		});

		expect(result.attestation).toBe('0x1234');
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(pendingStates).toHaveLength(2);
		expect(pendingStates[0]).toBeNull();
		const url = String(fetchMock.mock.calls[0]![0]);
		expect(url).toBe('https://iris-api.circle.com/v2/messages/8?transactionHash=digest');
	});

	it("surfaces non-404 errors with Circle's message", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse(400, { error: 'Invalid source/destination domain id' }));
		const client = new IrisClient('testnet', { fetch: fetchMock });
		await expect(client.getBurnFees(8, 0)).rejects.toMatchObject({
			name: 'IrisError',
			status: 400,
			message: 'Invalid source/destination domain id',
		} satisfies Partial<IrisError>);
		expect(String(fetchMock.mock.calls[0]![0])).toBe(
			'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/8/0',
		);
	});
});

describe('IrisClient resilience', () => {
	it('keeps polling through network errors, rate limits and 5xx, with backoff', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }))
			.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
			.mockResolvedValueOnce(
				jsonResponse(200, {
					messages: [
						{
							message: '0xabcd',
							attestation: '0x1234',
							eventNonce: '1',
							cctpVersion: 2,
							status: 'complete',
						},
					],
				}),
			);
		const client = new IrisClient('mainnet', { fetch: fetchMock });
		const result = await client.waitForAttestation(0, '0xhash', {
			intervalMs: 1,
			maxIntervalMs: 4,
		});
		expect(result.attestation).toBe('0x1234');
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('still fails fast on permanent errors', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse(400, { error: 'Invalid source domain id' }));
		const client = new IrisClient('mainnet', { fetch: fetchMock });
		await expect(client.waitForAttestation(99, '0xhash', { intervalMs: 1 })).rejects.toThrow(
			'Invalid source domain id',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('IrisClient waiting', () => {
	it('has no timeout by default and backs off while a message stays pending', async () => {
		let calls = 0;
		const fetchMock = vi.fn<typeof fetch>(async () => {
			calls += 1;
			return calls < 14
				? jsonResponse(200, {
						messages: [
							{
								message: '0x',
								attestation: 'PENDING',
								eventNonce: '1',
								cctpVersion: 2,
								status: 'pending_confirmations',
							},
						],
					})
				: jsonResponse(200, {
						messages: [
							{
								message: '0xabcd',
								attestation: '0x1234',
								eventNonce: '1',
								cctpVersion: 2,
								status: 'complete',
							},
						],
					});
		});
		const client = new IrisClient('mainnet', { fetch: fetchMock });
		const started = Date.now();
		const result = await client.waitForAttestation(0, '0xhash', {
			intervalMs: 2,
			maxIntervalMs: 8,
		});
		expect(result.attestation).toBe('0x1234');
		expect(calls).toBe(14);
		// 6 polls at 2 ms, 6 at 4 ms, then 8 ms: comfortably more than 13 × 2 ms flat polling.
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
	});

	it('honours an explicit timeout without leaking the hash into the message', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse(200, {
				messages: [
					{
						message: '0x',
						attestation: 'PENDING',
						eventNonce: '1',
						cctpVersion: 2,
						status: 'pending_confirmations',
					},
				],
			}),
		);
		const client = new IrisClient('mainnet', { fetch: fetchMock });
		await expect(
			client.waitForAttestation(0, '0xdeadbeef', { intervalMs: 1, timeoutMs: 5 }),
		).rejects.toThrow(/^Timed out waiting for Circle's attestation$/);
	});
});
