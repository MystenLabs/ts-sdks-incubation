// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { sameAddress } from './address.js';
import type { DepositAddress } from './address.js';

/** What the deposit service (`POST /api/deposit/process` on the claimer) answered. */
export interface DepositProcessAnswer {
	status: 'processed' | 'would_process' | 'empty' | 'ineligible' | 'blocked' | 'error';
	reason?: string;
	depositAddress?: string;
	burnTx?: string;
	lastBurnTx?: string;
}

/** A deposit that arrived at the address: what the chain showed before anything was burned. */
export interface IncomingDeposit {
	txHash: string;
	amount?: bigint;
}

/**
 * Where a watched deposit address stands.
 * - `waiting`: nothing there; send USDC.
 * - `received`: USDC is there and is being sent on to Sui.
 * - `belowMinimum`: what is there is too little to bridge; send more (it adds up).
 * - `unavailable`: the service could not process it now, and is asked again shortly.
 * - `mismatch`: the service derived a different address. Stop: do not send to this address.
 */
export type DepositPhase = 'waiting' | 'received' | 'belowMinimum' | 'unavailable' | 'mismatch';

export interface DepositState extends DepositAddress {
	from: string;
	recipient: string;
	phase: DepositPhase;
	/** USDC (base units) at the address when last read; null before the first read. */
	balance: bigint | null;
	minimum: bigint;
	/** What the processor keeps, in USDC base units. */
	keeperFee: bigint;
	/** The latest transfer into the address, as the chain shows it. */
	incoming: IncomingDeposit | null;
	/** Burns this address has sent on to Sui while watched, newest last. */
	burns: string[];
	/** What went wrong last, for the user. */
	error?: string;
}

export interface DepositWatcherDeps {
	readBalance(): Promise<bigint>;
	/** The latest transfer into the address, or null when none is found. Best effort. */
	findIncoming(): Promise<IncomingDeposit | null>;
	process(incoming: IncomingDeposit | null): Promise<DepositProcessAnswer>;
	/** Hand a burn to the kit, which attests and claims it like any other transfer. */
	track(burnTx: string): Promise<void>;
	update(state: DepositState): void;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** Between balance reads. */
	pollMs?: number;
	/** After the service could not process. */
	retryMs?: number;
}

/** How many times a burn the service named is handed to the kit before it is dropped. */
const TRACK_ATTEMPTS = 10;

/**
 * Watch one deposit address until `signal` aborts: read its balance, and when it can be bridged ask
 * the service to process it, then hand the burn to the kit. Nothing here is trusted blindly: the
 * service must name the address this client derived, and the kit checks the burn with Circle.
 *
 * The service is also asked once at the start, and again after any answer that settled nothing.
 * That checks its address before anyone sends, and finds a burn whose answer was lost (a timeout,
 * a reload): the deposit then reads empty, and only the service's `lastBurnTx` still points at it.
 */
export async function watchDepositAddress(
	initial: DepositState,
	deps: DepositWatcherDeps,
	signal: AbortSignal,
): Promise<void> {
	const pollMs = deps.pollMs ?? 4_000;
	const retryMs = deps.retryMs ?? 20_000;
	let state = initial;
	/** Burns the service named that the kit has not taken yet, with the attempts left. */
	const pending = new Map<string, number>();
	let askService = true;
	const set = (patch: Partial<DepositState>) => {
		state = { ...state, ...patch };
		if (!signal.aborted) deps.update(state);
	};
	const follow = (burnTx: string | undefined) => {
		if (burnTx && !state.burns.includes(burnTx) && !pending.has(burnTx)) {
			pending.set(burnTx, TRACK_ATTEMPTS);
		}
	};
	const trackPending = async () => {
		for (const [burnTx, left] of pending) {
			try {
				await deps.track(burnTx);
				pending.delete(burnTx);
				set({ burns: [...state.burns, burnTx] });
			} catch (error) {
				if (signal.aborted) return;
				if (left <= 1) pending.delete(burnTx);
				else pending.set(burnTx, left - 1);
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	};
	/** Ask the service, and act on what it says. False when it settled nothing. */
	const process = async (incoming: IncomingDeposit | null): Promise<boolean> => {
		const answer = await deps.process(incoming);
		if (answer.depositAddress && !sameAddress(answer.depositAddress, state.address)) {
			set({
				phase: 'mismatch',
				error: `The service derived ${answer.depositAddress}, not ${state.address}`,
			});
			throw MISMATCH;
		}
		if (answer.status === 'processed' && answer.burnTx) {
			follow(answer.burnTx);
			set({ phase: 'waiting', balance: 0n, error: undefined });
			return true;
		}
		if (answer.status === 'empty') {
			// Someone processed it first, or an earlier call timed out after sending.
			follow(answer.lastBurnTx);
			set({ phase: 'waiting', balance: 0n });
			return true;
		}
		if (answer.status === 'ineligible' && answer.reason === 'below_minimum') {
			set({ phase: 'belowMinimum' });
			return true;
		}
		if (answer.status === 'would_process') return true;
		set({ error: answer.reason ?? answer.status });
		return false;
	};

	while (!signal.aborted) {
		let wait = pollMs;
		try {
			const balance = await deps.readBalance();
			if (balance === 0n) {
				set({ balance, phase: 'waiting' });
				if (askService) askService = !(await process(null));
			} else {
				const incoming =
					state.incoming && state.balance === balance
						? state.incoming
						: await deps.findIncoming().catch(() => null);
				if (balance < state.minimum) {
					set({ balance, incoming, phase: 'belowMinimum', error: undefined });
					if (askService) askService = !(await process(incoming));
				} else {
					set({ balance, incoming, phase: 'received', error: undefined });
					askService = !(await process(incoming));
					if (askService) {
						set({ phase: 'unavailable' });
						wait = retryMs;
					}
				}
			}
			await trackPending();
		} catch (error) {
			if (error === MISMATCH || signal.aborted) return;
			askService = true;
			set({
				phase: state.phase === 'received' ? 'unavailable' : state.phase,
				error: error instanceof Error ? error.message : String(error),
			});
			wait = retryMs;
		}
		try {
			await deps.sleep(wait, signal);
		} catch {
			return;
		}
	}
}

const MISMATCH = new Error('deposit address mismatch');

/** Ask the service to process a deposit. A network failure is a `blocked` answer: try again later. */
export async function requestDepositProcess(args: {
	baseUrl: string;
	fetch?: typeof fetch;
	chain: string;
	recipient: string;
	owner: string | null;
	txHash?: string;
	signal?: AbortSignal;
}): Promise<DepositProcessAnswer> {
	const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
	try {
		const response = await doFetch(new URL('/api/deposit/process', args.baseUrl), {
			method: 'POST',
			// A CORS simple request: no preflight, one request per attempt against the rate limit.
			headers: { 'content-type': 'text/plain;charset=UTF-8' },
			body: JSON.stringify({
				chain: args.chain,
				sui: args.recipient,
				...(args.owner ? { owner: args.owner } : {}),
				...(args.txHash ? { txHash: args.txHash } : {}),
			}),
			signal: args.signal ?? AbortSignal.timeout(35_000),
		});
		const body = (await response.json().catch(() => null)) as DepositProcessAnswer | null;
		if (body && typeof body.status === 'string') return body;
		return { status: 'blocked', reason: `HTTP ${response.status}` };
	} catch (error) {
		if (args.signal?.aborted) throw error;
		return { status: 'blocked', reason: 'The deposit service did not answer' };
	}
}
