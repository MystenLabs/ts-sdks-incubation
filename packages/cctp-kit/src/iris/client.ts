// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Network } from '../chains/types.js';
import { sleep } from '../utils/sleep.js';

/** Circle's attestation service ("Iris"). */
export const IRIS_BASE_URL: Record<Network, string> = {
	mainnet: 'https://iris-api.circle.com',
	testnet: 'https://iris-api-sandbox.circle.com',
};

export interface IrisDecodedMessageBody {
	burnToken: string;
	mintRecipient: string;
	amount: string;
	messageSender: string;
	maxFee?: string;
	feeExecuted?: string;
	expirationBlock?: string;
	hookData?: string;
}

export interface IrisDecodedMessage {
	sourceDomain: string;
	destinationDomain: string;
	nonce: string;
	sender: string;
	recipient: string;
	destinationCaller: string;
	minFinalityThreshold?: string;
	finalityThresholdExecuted?: string;
	messageBody: string;
	decodedMessageBody?: IrisDecodedMessageBody;
}

export interface IrisMessage {
	/** Hex message bytes; "0x" while still pending. */
	message: string;
	eventNonce: string;
	/** Hex attestation; the literal string "PENDING" until the attesters have signed. */
	attestation: string;
	cctpVersion: number;
	status: 'complete' | 'pending_confirmations';
	delayReason?: string | null;
	decodedMessage?: IrisDecodedMessage;
}

export interface IrisMessagesResponse {
	messages: IrisMessage[];
	sourceTxHash?: string;
}

export interface IrisFeeTier {
	finalityThreshold: number;
	/** Fee in basis points of the burn amount. */
	minimumFee: number;
}

export interface IrisClientOptions {
	baseUrl?: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
}

export class IrisError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'IrisError';
	}
}

export class IrisClient {
	readonly baseUrl: string;
	readonly #headers: Record<string, string>;
	readonly #fetch: typeof fetch;

	constructor(network: Network, options: IrisClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? IRIS_BASE_URL[network]).replace(/\/$/, '');
		this.#headers = options.headers ?? {};
		this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
	}

	async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
		return this.#request(path, { signal });
	}

	async #request<T>(path: string, init: { method?: string; signal?: AbortSignal }): Promise<T> {
		const response = await this.#fetch(`${this.baseUrl}${path}`, {
			method: init.method ?? 'GET',
			headers: { accept: 'application/json', ...this.#headers },
			signal: init.signal,
		});
		if (!response.ok) {
			let detail = '';
			try {
				detail = ((await response.json()) as { error?: string }).error ?? '';
			} catch {
				// ignore
			}
			throw new IrisError(
				detail || `Iris request failed with HTTP ${response.status}`,
				response.status,
			);
		}
		return (await response.json()) as T;
	}

	/** Look up messages by source transaction hash (EVM hex hash, Sui digest, or Solana signature). */
	async getMessagesByTxHash(
		sourceDomain: number,
		transactionHash: string,
		signal?: AbortSignal,
	): Promise<IrisMessagesResponse> {
		const query = new URLSearchParams({ transactionHash });
		return this.#get(`/v2/messages/${sourceDomain}?${query}`, signal);
	}

	async getMessagesByNonce(
		sourceDomain: number,
		nonce: string,
		signal?: AbortSignal,
	): Promise<IrisMessagesResponse> {
		const query = new URLSearchParams({ nonce });
		return this.#get(`/v2/messages/${sourceDomain}?${query}`, signal);
	}

	/** Fee tiers for a route. Throws `IrisError` for routes Circle does not quote (e.g. Sui today). */
	async getBurnFees(sourceDomain: number, destinationDomain: number): Promise<IrisFeeTier[]> {
		return this.#get(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
	}

	async getFastBurnAllowance(): Promise<{ allowance: number; lastUpdated: string }> {
		return this.#get('/v2/fastBurn/USDC/allowance');
	}

	/**
	 * Ask Circle to sign a message again. A Fast Transfer message expires 24 hours after it was
	 * signed and the destination then rejects it; a new attestation carries a new expiry. Circle
	 * sets no deadline for asking. Poll `waitForAttestation` with `differentFrom` afterwards.
	 */
	async reattest(nonce: string, signal?: AbortSignal): Promise<void> {
		await this.#request(`/v2/reattest/${nonce}`, { method: 'POST', signal });
	}

	/**
	 * Poll until the attestation for a burn is complete. A 404 means Iris has not indexed
	 * the transaction yet and is treated as "still pending".
	 */
	/**
	 * Poll until the attestation for a burn is complete. There is no timeout by default: a
	 * standard transfer never expires, so a slow attester is a wait, not a failure. Polling
	 * backs off from `intervalMs` to `maxIntervalMs` the longer a message stays pending.
	 */
	async waitForAttestation(
		sourceDomain: number,
		transactionHash: string,
		options: {
			intervalMs?: number;
			maxIntervalMs?: number;
			/** Give up after this long; omit for no limit. */
			timeoutMs?: number;
			signal?: AbortSignal;
			onPending?: (m: IrisMessage | null) => void;
			/** Keep waiting while Circle still returns this attestation (after `reattest`). */
			differentFrom?: string;
		} = {},
	): Promise<IrisMessage> {
		const baseInterval = options.intervalMs ?? 5_000;
		const maxInterval = options.maxIntervalMs ?? 60_000;
		const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
		let pendingStreak = 0;
		let errorBackoff = 0;

		while (true) {
			options.signal?.throwIfAborted();
			let current: IrisMessage | null = null;
			try {
				const result = await this.getMessagesByTxHash(
					sourceDomain,
					transactionHash,
					options.signal,
				);
				current = result.messages[0] ?? null;
				if (current && isAttested(current) && current.attestation !== options.differentFrom) {
					return current;
				}
				errorBackoff = 0;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				if (!isTransientIrisFailure(error)) throw error;
				// Network blips, rate limits and Circle-side 5xx: keep waiting, backing off faster.
				errorBackoff += 1;
			}
			pendingStreak += 1;
			options.onPending?.(current);
			if (Date.now() > deadline) {
				throw new IrisError("Timed out waiting for Circle's attestation");
			}
			// Six polls at each step before doubling: 5 s for the first 30 s, then 10 s, 20 s, ...
			const step = Math.floor(pendingStreak / 6) + errorBackoff;
			const interval = Math.min(baseInterval * 2 ** step, maxInterval);
			await sleep(interval, options.signal);
		}
	}
}

/**
 * Errors that mean "ask again later" rather than "this will never succeed": a 404 (Circle has
 * not indexed the transaction yet), 429, any 5xx, or a failed network request.
 */
export function isTransientIrisFailure(error: unknown): boolean {
	if (error instanceof IrisError) {
		return (
			error.status === 404 ||
			error.status === 429 ||
			(error.status !== undefined && error.status >= 500)
		);
	}
	// fetch() rejects with a TypeError ("Failed to fetch", "Load failed") when the network is down.
	return (
		error instanceof TypeError || (error instanceof Error && /fetch|network/i.test(error.message))
	);
}

export function isAttested(message: IrisMessage): boolean {
	return (
		message.status === 'complete' &&
		typeof message.attestation === 'string' &&
		message.attestation !== 'PENDING' &&
		message.attestation.startsWith('0x') &&
		message.message.length > 2
	);
}
