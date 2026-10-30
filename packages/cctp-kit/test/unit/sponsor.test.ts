// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import {
	classifySponsorResponse,
	parseRetryAfter,
	SponsorClient,
	sponsorServes,
} from '../../src/sponsor/client.js';
import type { SponsorAnswer, SponsorStatus, SponsorVerdict } from '../../src/sponsor/client.js';

const BASE_URL = 'https://claimer.example';
const CLAIM_URL = `${BASE_URL}/api/claim`;
const MESSAGE = `0x${'aa'.repeat(376)}`;
const ATTESTATION = `0x${'bb'.repeat(65)}`;
const DIGEST = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';
const HEALTHY = {
	ok: true,
	address: `0x${'ab'.repeat(32)}`,
	gasBalance: '9995658109',
	mintAllowance: '21397715992655',
	dryRun: false,
};
const DENYLIST = {
	sourceDomains: [
		{ domain: 10, name: 'Unichain' },
		{ domain: 13, name: 'Sonic' },
	],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });

/** Answers in turn, repeating the last one. An `Error` is a fetch that rejects. */
const answering = (...answers: (Response | Error)[]) =>
	vi.fn<typeof fetch>(async () => {
		const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
		if (answer instanceof Error) throw answer;
		return answer.clone();
	});

/** A fetch that never answers, but stops when it is told to. */
const hanging = () =>
	vi.fn<typeof fetch>(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
					once: true,
				});
			}),
	);

/** A client whose waits take no time, and whose clock moves only by them. */
function virtualClient(fetchMock: typeof fetch) {
	const time = { now: 1_000_000 };
	const waits: number[] = [];
	const client = new SponsorClient({
		baseUrl: BASE_URL,
		fetch: fetchMock,
		now: () => time.now,
		random: () => 0.5,
		sleep: async (ms) => {
			waits.push(ms);
			time.now += ms;
		},
	});
	return { client, waits, time };
}

describe('sponsorServes', () => {
	const chains = getChainRegistry('mainnet');
	const chain = (key: string) => chains.find((c) => c.key === key)!;
	const ethereum = chain('ethereum');
	const unichain = chain('unichain');
	const sui = chain('sui');
	const read = (over: Partial<SponsorStatus> = {}): SponsorStatus => ({
		health: { ok: true, dryRun: false },
		deniedDomains: [unichain.domain],
		checkedAt: 1,
		...over,
	});

	it.each<[string, SponsorStatus | null, boolean]>([
		['healthy, with the source not denied', read(), true],
		['an empty denylist that was read', read({ deniedDomains: [] }), true],
		['nothing read yet', null, false],
		['health answered 503', read({ health: { ok: false, dryRun: false } }), false],
		['health unreachable', read({ health: null }), false],
		['a dry run', read({ health: { ok: true, dryRun: true } }), false],
		['the denylist not read', read({ deniedDomains: null }), false],
	])('from Ethereum to Sui: %s', (_name, status, served) => {
		expect(sponsorServes(status, ethereum, sui)).toBe(served);
	});

	it('refuses a source on the denylist and takes the one next to it', () => {
		expect(sponsorServes(read(), unichain, sui)).toBe(false);
		expect(sponsorServes(read({ deniedDomains: [ethereum.domain] }), unichain, sui)).toBe(true);
	});

	it('serves no destination but Sui', () => {
		expect(sponsorServes(read(), sui, ethereum)).toBe(false);
		expect(sponsorServes(read(), sui, chain('solana'))).toBe(false);
	});
});

describe('classifySponsorResponse', () => {
	const retry = expect.objectContaining({ action: 'retry' });
	const giveUp = expect.objectContaining({ action: 'giveUp' });
	const blocked = (reason: string, over: object = {}) => ({
		status: 503,
		body: { status: 'blocked', reason, ...over },
	});
	const table: [string, SponsorAnswer, SponsorVerdict | typeof retry][] = [
		[
			'200 claimed with a digest',
			{ status: 200, body: { status: 'claimed', digest: DIGEST } },
			{ action: 'claimed', digest: DIGEST },
		],
		[
			'200 already_claimed',
			{ status: 200, body: { status: 'already_claimed' } },
			{ action: 'alreadyClaimed' },
		],
		['429 with no body', { status: 429 }, retry],
		['429 with a body', { status: 429, body: { error: 'slow down' } }, retry],
		['503 congested with no failedDigest', blocked('congested'), retry],
		['502', { status: 502, body: { status: 'error', message: 'proxied' } }, retry],
		['504', { status: 504 }, retry],
		['a 503 that is not JSON', { status: 503 }, retry],
		['a 500 that is not JSON', { status: 500 }, retry],
		['a 500 with JSON but no status', { status: 500, body: { error: 'crash' } }, retry],
		['a 500 with a JSON array', { status: 500, body: [] }, retry],
		['a 599 with a status that is no string', { status: 599, body: { status: 1 } }, retry],
		['a rejected fetch', { failed: 'network' }, retry],
		['the attempt timing out', { failed: 'timeout' }, retry],
		['200 would_claim', { status: 200, body: { status: 'would_claim' } }, giveUp],
		['400 with the error shape', { status: 400, body: { error: 'expected hex' } }, giveUp],
		['409 expired', { status: 409, body: { status: 'expired' } }, giveUp],
		['422 ineligible', { status: 422, body: { status: 'ineligible', reason: 'x' } }, giveUp],
		['500 error', { status: 500, body: { status: 'error', message: 'unknown' } }, giveUp],
		...['paused', 'allowance', 'denied', 'low_gas', 'stale_package'].map(
			(reason): [string, SponsorAnswer, typeof giveUp] => [
				`503 blocked by ${reason}`,
				blocked(reason),
				giveUp,
			],
		),
		['503 blocked for no reason', { status: 503, body: { status: 'blocked' } }, giveUp],
		// It failed on chain: every retry in this epoch signs the same bytes and fails the same way.
		['503 congested with a failedDigest', blocked('congested', { failedDigest: DIGEST }), giveUp],
		['503 paused with a failedDigest', blocked('paused', { failedDigest: DIGEST }), giveUp],
		['200 of an unknown shape', { status: 200, body: { ok: true } }, giveUp],
		['200 that is not JSON', { status: 200 }, giveUp],
		['200 claimed with no digest', { status: 200, body: { status: 'claimed' } }, giveUp],
		[
			'200 claimed with a digest that is no string',
			{ status: 200, body: { status: 'claimed', digest: 7 } },
			giveUp,
		],
		[
			'200 claimed with an empty digest',
			{ status: 200, body: { status: 'claimed', digest: '' } },
			giveUp,
		],
		['201 claimed', { status: 201, body: { status: 'claimed', digest: DIGEST } }, giveUp],
		['404', { status: 404 }, giveUp],
		['403', { status: 403, body: { error: 'firewall' } }, giveUp],
		['a redirect', { status: 301 }, giveUp],
	];

	it.each(table)('%s', (_name, answer, verdict) => {
		expect(classifySponsorResponse(answer)).toEqual(verdict);
	});

	it('names what it gave up on, for whoever reads the result', () => {
		expect(classifySponsorResponse(blocked('paused'))).toEqual({
			action: 'giveUp',
			reason: 'HTTP 503 blocked paused',
		});
		expect(classifySponsorResponse({ failed: 'timeout' })).toEqual({
			action: 'retry',
			reason: 'timeout',
		});
	});
});

describe('parseRetryAfter', () => {
	const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

	it.each([
		['0', 0],
		['1', 1_000],
		[' 60 ', 60_000],
		['Wed, 21 Oct 2026 07:28:10 GMT', 10_000],
		// A date that has passed asks for no wait.
		['Wed, 21 Oct 2026 07:27:00 GMT', 0],
		[null, null],
		['', null],
		['soon', null],
		// `Date.parse` takes both of these for dates.
		['1.5', null],
		['soon 5', null],
		['-1', null],
	])('%s', (value, expected) => {
		expect(parseRetryAfter(value, now)).toBe(expected);
	});
});

describe('the sponsor status', () => {
	afterEach(() => vi.useRealTimers());

	/** The health and denylist endpoints, answering as given. */
	const service = (
		health: () => Response | Promise<Response> = () => json(200, HEALTHY),
		denylist: () => Response | Promise<Response> = () => json(200, DENYLIST),
	) =>
		vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith('/api/health') ? health() : denylist(),
		);

	it('is two plain GETs against the base URL, with or without a trailing slash', async () => {
		for (const baseUrl of [BASE_URL, `${BASE_URL}/`]) {
			const fetchMock = service();
			const client = new SponsorClient({ baseUrl, fetch: fetchMock });
			await client.status();
			expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
				`${BASE_URL}/api/denylist`,
				`${BASE_URL}/api/health`,
			]);
			// A custom header would make the browser send a preflight first.
			for (const [, init] of fetchMock.mock.calls) {
				expect(init?.method ?? 'GET').toBe('GET');
				expect(init?.headers).toBeUndefined();
			}
		}
	});

	it('reads what the service says', async () => {
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: service(), now: () => 7 });
		await expect(client.status()).resolves.toEqual({
			health: { ok: true, dryRun: false },
			deniedDomains: [10, 13],
			checkedAt: 7,
		});
		expect(client.denies(10)).toBe(true);
		expect(client.denies(0)).toBe(false);
	});

	it('tells the kit about every read', async () => {
		const onStatus = vi.fn();
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: service(), onStatus });
		const status = await client.status();
		expect(onStatus).toHaveBeenCalledExactlyOnceWith(status);
	});

	it('counts a 503 from health as an answer, and one with no JSON as none', async () => {
		const down = new SponsorClient({
			baseUrl: BASE_URL,
			fetch: service(() => json(503, { ok: false, error: 'no gas' })),
		});
		expect((await down.status()).health).toMatchObject({ ok: false });
		const crashed = new SponsorClient({
			baseUrl: BASE_URL,
			fetch: service(() => new Response('<html>', { status: 503 })),
		});
		expect((await crashed.status()).health).toBeNull();
	});

	it('takes a service that does not say it is live for a dry run', async () => {
		const client = new SponsorClient({
			baseUrl: BASE_URL,
			fetch: service(() => json(200, { ok: true })),
		});
		expect((await client.status()).health).toEqual({ ok: true, dryRun: true });
	});

	it.each([
		['a failed read', () => Promise.reject(new TypeError('Failed to fetch'))],
		['a 404', () => json(404, DENYLIST)],
		['no list in the answer', () => json(200, {})],
		['a list of something else', () => json(200, { sourceDomains: [{ name: 'Sonic' }] })],
		['no JSON', () => new Response('nope')],
	])('does not take %s for an empty denylist', async (_name, denylist) => {
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: service(undefined, denylist) });
		expect((await client.status()).deniedDomains).toBeNull();
		expect(client.denies(10)).toBe(false);
	});

	it('is held for 60 s, then read again on demand', async () => {
		const fetchMock = service();
		const time = { now: 0 };
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock, now: () => time.now });
		await client.status();
		time.now = 59_999;
		await client.status();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		time.now = 60_000;
		await client.status();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('shares one read between callers that arrive together', async () => {
		const fetchMock = service();
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
		const [first, second] = await Promise.all([client.status(), client.status()]);
		expect(first).toBe(second);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('holds a read that failed for as long as any other', async () => {
		const fetchMock = service(() => Promise.reject(new TypeError('Failed to fetch')));
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
		await client.status();
		await client.status();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('keeps the denylist it has when a later read of it fails, but never the health', async () => {
		const time = { now: 0 };
		let up = true;
		const client = new SponsorClient({
			baseUrl: BASE_URL,
			now: () => time.now,
			fetch: service(
				() => (up ? json(200, HEALTHY) : Promise.reject(new TypeError('Failed to fetch'))),
				() => (up ? json(200, DENYLIST) : Promise.reject(new TypeError('Failed to fetch'))),
			),
		});
		await client.status();
		up = false;
		time.now = 60_000;
		await expect(client.status()).resolves.toMatchObject({
			health: null,
			deniedDomains: [10, 13],
		});
		expect(client.denies(10)).toBe(true);
	});

	it('gives each GET 5 s, and then knows nothing', async () => {
		vi.useFakeTimers();
		const fetchMock = hanging();
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
		const status = client.status();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(status).resolves.toMatchObject({ health: null, deniedDomains: null });
	});

	it('lets a waiter go when it aborts, and leaves the read to the others', async () => {
		const controller = new AbortController();
		const release: ((response: Response) => void)[] = [];
		const client = new SponsorClient({
			baseUrl: BASE_URL,
			fetch: vi.fn<typeof fetch>(() => new Promise((resolve) => release.push(resolve))),
		});
		const leaving = client.status(controller.signal);
		const staying = client.status();
		controller.abort(new Error('destroyed'));
		await expect(leaving).rejects.toThrow('destroyed');
		release[0]!(json(200, HEALTHY));
		release[1]!(json(200, DENYLIST));
		await expect(staying).resolves.toMatchObject({ health: { ok: true } });
	});

	it('rejects a waiter that has aborted even with a good status in hand', async () => {
		const client = new SponsorClient({ baseUrl: BASE_URL, fetch: service() });
		await client.status();
		await expect(client.status(AbortSignal.abort(new Error('destroyed')))).rejects.toThrow(
			'destroyed',
		);
	});
});

describe('a claim', () => {
	afterEach(() => vi.useRealTimers());

	it('is one simple request, with the hex as Iris returned it', async () => {
		for (const baseUrl of [BASE_URL, `${BASE_URL}/`]) {
			const fetchMock = answering(json(200, { status: 'claimed', digest: DIGEST }));
			const client = new SponsorClient({ baseUrl, fetch: fetchMock });
			await client.claim(MESSAGE, ATTESTATION);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [target, init] = fetchMock.mock.calls[0]!;
			expect(target).toBe(CLAIM_URL);
			expect(init!.method).toBe('POST');
			// Any other header would make the browser send a preflight, which the rate limit counts.
			expect(init!.headers).toEqual({ 'content-type': 'text/plain;charset=UTF-8' });
			expect(JSON.parse(init!.body as string)).toEqual({
				message: MESSAGE,
				attestation: ATTESTATION,
			});
		}
	});

	it('falls back to the global fetch, called as a plain function', async () => {
		const global = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(json(200, { status: 'already_claimed' }));
		const client = new SponsorClient({ baseUrl: BASE_URL });
		await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
			status: 'alreadyClaimed',
		});
		expect(global).toHaveBeenCalledTimes(1);
	});

	it('reports claimed and already claimed from the first answer', async () => {
		const claimed = virtualClient(answering(json(200, { status: 'claimed', digest: DIGEST })));
		await expect(claimed.client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
			status: 'claimed',
			digest: DIGEST,
		});
		expect(claimed.waits).toEqual([]);
		const already = virtualClient(answering(json(200, { status: 'already_claimed' })));
		await expect(already.client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
			status: 'alreadyClaimed',
		});
	});

	it('gives up at once on what is not worth another attempt', async () => {
		const fetchMock = answering(json(422, { status: 'ineligible', reason: 'below_minimum' }));
		const { client, waits } = virtualClient(fetchMock);
		await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
			status: 'gaveUp',
			reason: 'HTTP 422 ineligible below_minimum',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(waits).toEqual([]);
	});

	it('retries three times after the first attempt, then reports the last reason', async () => {
		const fetchMock = answering(
			json(429, {}),
			json(502, {}),
			new TypeError('Load failed'),
			new Response('upstream died', { status: 504 }),
		);
		const { client, waits } = virtualClient(fetchMock);
		await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
			status: 'gaveUp',
			reason: 'HTTP 504',
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		// 2 s, 4 s, 8 s, each scaled by the random factor (0.75 here), and none after the last.
		expect(waits).toEqual([1_500, 3_000, 6_000]);
	});

	it('jitters each wait between half and all of its step', async () => {
		for (const [random, first] of [
			[0, 1_000],
			[0.999, 1_999],
		] as const) {
			const waits: number[] = [];
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: answering(json(429, {}), json(200, { status: 'already_claimed' })),
				random: () => random,
				sleep: async (ms) => void waits.push(ms),
			});
			await client.claim(MESSAGE, ATTESTATION);
			expect(waits).toHaveLength(1);
			expect(waits[0]).toBeCloseTo(first, 0);
		}
	});

	it('stops at a congestion that failed on chain', async () => {
		const fetchMock = answering(
			json(503, { status: 'blocked', reason: 'congested', failedDigest: DIGEST }),
		);
		const { client, waits } = virtualClient(fetchMock);
		await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toMatchObject({ status: 'gaveUp' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(waits).toEqual([]);
	});

	describe('Retry-After', () => {
		it('is waited out when it can be read', async () => {
			const fetchMock = answering(
				json(429, {}, { 'retry-after': '1' }),
				json(200, { status: 'claimed', digest: DIGEST }),
			);
			const { client, waits } = virtualClient(fetchMock);
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toMatchObject({
				status: 'claimed',
			});
			expect(waits).toEqual([1_000]);
		});

		it('is read as a date too', async () => {
			const { client, waits, time } = virtualClient(
				answering(
					new Response('', {
						status: 429,
						headers: { 'retry-after': new Date(1_000_000 + 5_000).toUTCString() },
					}),
					json(200, { status: 'already_claimed' }),
				),
			);
			time.now = 1_000_000;
			await client.claim(MESSAGE, ATTESTATION);
			expect(waits).toEqual([5_000]);
		});

		it('gives up without waiting when it asks for more than 20 s', async () => {
			const fetchMock = answering(json(429, {}, { 'retry-after': '60' }));
			const { client, waits } = virtualClient(fetchMock);
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
				status: 'gaveUp',
				reason: 'HTTP 429',
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(waits).toEqual([]);
		});

		it('gives up on 21 s, which the overall limit alone would have allowed', async () => {
			const fetchMock = answering(json(429, {}, { 'retry-after': '21' }));
			const { client, waits } = virtualClient(fetchMock);
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toMatchObject({
				status: 'gaveUp',
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(waits).toEqual([]);
		});

		it('waits for exactly 20 s', async () => {
			const { client, waits } = virtualClient(
				answering(json(429, {}, { 'retry-after': '20' }), json(200, { status: 'already_claimed' })),
			);
			await client.claim(MESSAGE, ATTESTATION);
			expect(waits).toEqual([20_000]);
		});

		it('is not needed: without it the usual wait applies', async () => {
			// A cross-origin page cannot see the header unless the server exposes it.
			const { client, waits } = virtualClient(
				answering(json(429, {}), json(200, { status: 'already_claimed' })),
			);
			await client.claim(MESSAGE, ATTESTATION);
			expect(waits).toEqual([1_500]);
		});

		it('is ignored on an answer that gives up anyway', async () => {
			const fetchMock = answering(
				json(503, { status: 'blocked', reason: 'paused' }, { 'retry-after': '1' }),
			);
			const { client, waits } = virtualClient(fetchMock);
			await client.claim(MESSAGE, ATTESTATION);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(waits).toEqual([]);
		});
	});

	describe('the overall limit', () => {
		/** Each attempt uses up `ms` of the clock before it fails. */
		function slowAttempts(ms: number, answer: () => Response) {
			const time = { now: 0 };
			const waits: number[] = [];
			const fetchMock = vi.fn<typeof fetch>(async () => {
				time.now += ms;
				return answer();
			});
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: fetchMock,
				now: () => time.now,
				random: () => 0.5,
				sleep: async (wait) => {
					waits.push(wait);
					time.now += wait;
				},
			});
			return { client, fetchMock, waits, time };
		}

		it('stops retrying once 60 s have passed since the first attempt started', async () => {
			const { client, fetchMock, waits } = slowAttempts(25_000, () => json(502, {}));
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toEqual({
				status: 'gaveUp',
				reason: 'HTTP 502',
			});
			// The third attempt starts at 54.5 s and ends at 79.5 s: past the limit, with a retry
			// still in hand.
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(waits).toEqual([1_500, 3_000]);
		});

		it('does not sit through a wait that would end past the limit', async () => {
			const { client, fetchMock, waits } = slowAttempts(45_000, () =>
				json(429, {}, { 'retry-after': '20' }),
			);
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toMatchObject({
				status: 'gaveUp',
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(waits).toEqual([]);
		});

		it('sends nothing more when a wait ran long, as timers do in a background tab', async () => {
			const time = { now: 0 };
			const fetchMock = answering(json(429, {}));
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: fetchMock,
				now: () => time.now,
				random: () => 0.5,
				sleep: async () => {
					time.now = 61_000;
				},
			});
			await expect(client.claim(MESSAGE, ATTESTATION)).resolves.toMatchObject({
				status: 'gaveUp',
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('the per-attempt timeout', () => {
		it('is 35 s, and an attempt that reaches it is retried', async () => {
			vi.useFakeTimers();
			const fetchMock = hanging();
			fetchMock.mockImplementationOnce(hanging());
			fetchMock.mockResolvedValueOnce(json(200, { status: 'already_claimed' }));
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: fetchMock,
				sleep: async () => undefined,
			});
			const result = client.claim(MESSAGE, ATTESTATION);
			await vi.advanceTimersByTimeAsync(34_999);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
			await expect(result).resolves.toEqual({ status: 'alreadyClaimed' });
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('with 35 s attempts, sends only the two that start within the 60 s', async () => {
			vi.useFakeTimers();
			const fetchMock = hanging();
			const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock, random: () => 1 });
			const result = client.claim(MESSAGE, ATTESTATION);
			// 35 s, a 2 s wait, 35 s more: the second attempt ends at 72 s.
			await vi.advanceTimersByTimeAsync(72_000);
			await expect(result).resolves.toEqual({ status: 'gaveUp', reason: 'timeout' });
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('leaves no timer behind once an attempt has answered', async () => {
			vi.useFakeTimers();
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: answering(json(200, { status: 'already_claimed' })),
			});
			await client.claim(MESSAGE, ATTESTATION);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('ends an attempt whose fetch ignores the signal', async () => {
			vi.useFakeTimers();
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: vi.fn<typeof fetch>(() => new Promise(() => undefined)),
				sleep: async () => undefined,
			});
			const result = client.claim(MESSAGE, ATTESTATION);
			await vi.advanceTimersByTimeAsync(35_000);
			await vi.advanceTimersByTimeAsync(35_000);
			await expect(result).resolves.toEqual({ status: 'gaveUp', reason: 'timeout' });
		});

		it('covers a body that stops halfway through', async () => {
			vi.useFakeTimers();
			const stalled = new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: answering(stalled),
				sleep: async () => undefined,
			});
			const result = client.claim(MESSAGE, ATTESTATION);
			await vi.advanceTimersByTimeAsync(35_000);
			await vi.advanceTimersByTimeAsync(35_000);
			await expect(result).resolves.toEqual({ status: 'gaveUp', reason: 'timeout' });
		});
	});

	describe('the caller aborting', () => {
		it('cancels a request in flight, and rejects with the reason', async () => {
			const fetchMock = hanging();
			const controller = new AbortController();
			const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
			const result = client.claim(MESSAGE, ATTESTATION, controller.signal);
			controller.abort(new Error('destroyed'));
			await expect(result).rejects.toThrow('destroyed');
			expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('rejects during the last attempt, rather than reporting that it gave up', async () => {
			const controller = new AbortController();
			const fetchMock = hanging();
			for (let attempt = 0; attempt < 3; attempt++) {
				fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
			}
			const { client } = virtualClient(fetchMock);
			const result = client.claim(MESSAGE, ATTESTATION, controller.signal);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
			controller.abort(new Error('destroyed'));
			await expect(result).rejects.toThrow('destroyed');
		});

		it('rejects even when the fetch ignores the signal', async () => {
			const controller = new AbortController();
			const client = new SponsorClient({
				baseUrl: BASE_URL,
				fetch: vi.fn<typeof fetch>(() => new Promise(() => undefined)),
			});
			const result = client.claim(MESSAGE, ATTESTATION, controller.signal);
			controller.abort(new Error('destroyed'));
			await expect(result).rejects.toThrow('destroyed');
		});

		it('cancels the wait between attempts', async () => {
			const controller = new AbortController();
			const fetchMock = answering(new TypeError('Failed to fetch'));
			const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
			const result = client.claim(MESSAGE, ATTESTATION, controller.signal);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 0));
			controller.abort(new Error('destroyed'));
			await expect(result).rejects.toThrow('destroyed');
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('sends nothing when it has happened already', async () => {
			const fetchMock = answering(json(200, { status: 'already_claimed' }));
			const client = new SponsorClient({ baseUrl: BASE_URL, fetch: fetchMock });
			await expect(
				client.claim(MESSAGE, ATTESTATION, AbortSignal.abort(new Error('destroyed'))),
			).rejects.toThrow('destroyed');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('does not need AbortSignal.any, which older Safari lacks', async () => {
			const any = vi.spyOn(AbortSignal, 'any');
			const controller = new AbortController();
			const client = new SponsorClient({ baseUrl: BASE_URL, fetch: hanging() });
			const result = client.claim(MESSAGE, ATTESTATION, controller.signal);
			controller.abort(new Error('destroyed'));
			await expect(result).rejects.toThrow('destroyed');
			expect(any).not.toHaveBeenCalled();
		});
	});
});
