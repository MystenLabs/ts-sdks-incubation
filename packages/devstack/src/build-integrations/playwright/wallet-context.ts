// Wallet-context test helpers.
//
// Architecture (distilled/23-build-integrations.md § Playwright /
// "What it produces"):
//
//   In-spec helpers (`connectAs`, `selectAccount`) and the
//   `loadStackManifest` artifact loader. (`loadStackKeypair` is not
//   implemented — keys never leave the wallet plugin; tests sign via
//   the wallet's HTTP API.)
//
// And (per the user task brief): tests sign txs via the wallet's HTTP
// API rather than driving the browser's wallet-UI flow. That is the
// load-bearing wallet-context contract: a tiny typed HTTP client over
// the dev wallet's endpoint exposed in the manifest.
//
// Discipline:
//   - This module performs NO browser interaction. The `page` arg in
//     `connectAs` is the Playwright `Page` (kept structural — we do
//     not import `@playwright/test`), but the helpers here only use
//     it to expose the dev-wallet selection / account-switch flow
//     through `evaluate`. The actual key handling stays server-side
//     in the wallet plugin.
//   - HTTP calls go through `fetch`. We do NOT pull in `@mysten/sui`
//     here — txs are constructed by tests, serialized, and POSTed
//     to the wallet for signing. The wallet plugin is the
//     authoritative key holder.
//   - Account-switch via the global slot (`globalThis.__devstackDAppKit__`)
//     for dapp-kit-driven in-browser context; HTTP wallet helpers
//     are the spec-level lower-friction path.

import {
	readStackContext,
	type ResolveStackContextOptions,
	type StackContext,
} from './stack-context.ts';
import { readStashedFixture } from './global-setup.ts';
import { PlaywrightWalletAdapterError } from './errors.ts';
import { DAPP_KIT_SLOT_KEY, type DAppKitSlot } from '../runtime/dapp-kit-slot.ts';
// The wallet plugin owns the wire-protocol path constants AND the
// canonical endpoint name. Both are surfaced through the L5 runtime
// bridge so this adapter never reaches into L2 plugin code directly
// (ARCHITECTURE.md § Layer table — L5 reads only the runtime bridge).
import { WalletHttpPath, WALLET_ENDPOINT_KEY } from '../runtime/wallet-paths.ts';

// -----------------------------------------------------------------------------
// Structural Playwright `Page` shape — we keep `@playwright/test` an
// optional peer.
// -----------------------------------------------------------------------------

/** Subset of `Page` we use. */
export interface PlaywrightPageLike {
	readonly evaluate: <T>(fn: (arg: unknown) => T, arg?: unknown) => Promise<T>;
}

// -----------------------------------------------------------------------------
// Wallet adapter — HTTP client targeting the wallet plugin's endpoint
// -----------------------------------------------------------------------------

// `WALLET_ENDPOINT_KEY` is the short form Playwright/vitest helpers look
// up — the manifest stores the canonical endpoint name
// (`WALLET_ENDPOINT_NAME` — `'wallet-app'`) but the substrate's alias
// resolver folds the key to the canonical name. Re-exported from the L5
// runtime bridge so the spelling + canonical pairing stay aligned with
// the wallet plugin.
export { WALLET_ENDPOINT_KEY };

export interface WalletAdapterOptions extends ResolveStackContextOptions {
	/** Override the resolved wallet URL. Useful for tests targeting a
	 *  remote / non-default stack. */
	readonly walletUrl?: string;
	/** Custom `fetch` for tests. Defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Per-request timeout in ms. Default: 5_000. */
	readonly timeoutMs?: number;
}

/** Public shape of the wallet adapter — typed by-key methods plus the
 *  raw `request` escape hatch. */
export interface WalletAdapter {
	/** Resolved base URL of the wallet plugin. */
	readonly walletUrl: string;

	/** List dev-wallet account names + addresses. */
	readonly listAccounts: () => Promise<ReadonlyArray<DevAccount>>;

	/** Sign + execute a serialized transaction as `accountName`.
	 *  `txBytes` is the canonical Sui tx bytes (base64). Returns the
	 *  wallet's response body (typed `unknown` — caller decodes).
	 *
	 *  NOTE on account switching: the HTTP wallet server has no
	 *  `/accounts/switch` endpoint — active-account selection is owned
	 *  by the dapp-kit slot. Use `selectAccount` / `connectAs` below. */
	readonly signTransaction: (input: SignTxRequest) => Promise<SignTxResponse>;

	/** Raw POST escape hatch. Used by the helpers above and by tests
	 *  that need a wallet-endpoint not in the typed surface. */
	readonly request: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
}

export interface DevAccount {
	readonly name: string;
	readonly address: string;
}

export interface SignTxRequest {
	readonly accountName: string;
	/** Canonical Sui tx bytes, base64-encoded. */
	readonly txBytesBase64: string;
	/** Optional caller-supplied label for correlated trace output. */
	readonly label?: string;
}

export interface SignTxResponse {
	readonly digest: string;
	readonly signature: string;
	/** Raw response payload (wallet-plugin-versioned shape). */
	readonly raw: unknown;
}

// -----------------------------------------------------------------------------
// Resolver: locate the wallet URL via fixture > manifest > error
// -----------------------------------------------------------------------------

/**
 * Resolve the dev-wallet URL. Precedence:
 *   1. `options.walletUrl` (explicit override).
 *   2. The fixture stashed by `globalSetup` on `globalThis`.
 *   3. A fresh manifest read.
 *
 * Throws `PlaywrightWalletAdapterError` when every path misses. */
const resolveWalletUrl = (options: WalletAdapterOptions): string => {
	if (options.walletUrl !== undefined) return options.walletUrl;

	const fixture = readStashedFixture();
	if (fixture !== null && fixture.walletEndpoint !== null) {
		return fixture.walletEndpoint;
	}

	let ctx: StackContext;
	try {
		ctx = readStackContext(options);
	} catch (cause) {
		throw new PlaywrightWalletAdapterError({
			message:
				`unable to resolve dev-wallet URL — no globalSetup fixture and ` + `manifest read failed`,
			operation: 'fetch',
			cause,
		});
	}
	const walletUrl = ctx.endpointMaybe(WALLET_ENDPOINT_KEY);
	if (walletUrl === null) {
		throw new PlaywrightWalletAdapterError({
			message:
				`manifest has no \`${WALLET_ENDPOINT_KEY}\` endpoint (alias for ` +
				`\`wallet-app\`) — is the dev-wallet plugin present in your stack? ` +
				`Available endpoint names: ${ctx.endpointNames.join(', ') || '(none)'}. ` +
				`Raw manifest keys: ${ctx.manifestEndpointKeys.join(', ') || '(none)'}.`,
			operation: 'fetch',
		});
	}
	return walletUrl;
};

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Build a wallet adapter. Most tests call this once per `test`
 * fixture; the resolution is sync (a hash-lookup on the
 * fixture / manifest) so this is cheap.
 */
export const createWalletAdapter = (options: WalletAdapterOptions = {}): WalletAdapter => {
	const walletUrl = resolveWalletUrl(options).replace(/\/$/, '');
	const fetchImpl = options.fetch ?? globalThis.fetch;
	// 30s default — Playwright's webServer cold-start (vite + first
	// devstack bring-up) routinely exceeds 5s under CI parallelism; the
	// shorter default surfaces as a spurious AbortError before the
	// wallet plugin has finished publishing its HTTP route. Callers can
	// still tighten via `options.timeoutMs` for hot-path assertions.
	const timeoutMs = options.timeoutMs ?? 30_000;

	const request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
		const url = `${walletUrl}${path.startsWith('/') ? path : `/${path}`}`;
		const controller = new AbortController();
		const handle = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchImpl(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				throw new PlaywrightWalletAdapterError({
					message: `wallet request ${path} failed: HTTP ${res.status}`,
					operation: 'fetch',
					url,
					status: res.status,
				});
			}
			return (await res.json()) as T;
		} catch (cause) {
			if (cause instanceof PlaywrightWalletAdapterError) throw cause;
			throw new PlaywrightWalletAdapterError({
				message: `wallet request ${path} threw`,
				operation: 'fetch',
				url,
				cause,
			});
		} finally {
			clearTimeout(handle);
		}
	};

	return {
		walletUrl,
		// Paths come from the wallet plugin's canonical wire-protocol
		// module. Hard-coded literals here would silently 404 the moment
		// `WalletHttpPath` is reorganised, with no compile-time signal.
		listAccounts: () => request<ReadonlyArray<DevAccount>>(WalletHttpPath.ACCOUNTS),
		signTransaction: (input: SignTxRequest) =>
			request<SignTxResponse>(WalletHttpPath.SIGN_TRANSACTION, {
				accountName: input.accountName,
				txBytesBase64: input.txBytesBase64,
				label: input.label,
			}),
		request,
	};
};

// -----------------------------------------------------------------------------
// In-spec helpers — `connectAs` and `selectAccount`
// -----------------------------------------------------------------------------

/** Slot name owned by the app's `dapp-kit.ts`. The build integration
 *  reads it; the app populates it. Re-exported from `runtime/`'s
 *  canonical contract — kept here as a name alias for the
 *  in-spec-helpers' import path. */
export const DAPP_KIT_SLOT = DAPP_KIT_SLOT_KEY;

const SELECT_ACCOUNT_SLOT_TIMEOUT_MS = 10_000;
const SELECT_ACCOUNT_SLOT_POLL_MS = 50;

/**
 * Outcome of classifying a single `page.evaluate` result inside the
 * slot-poll loop. `done` resolves the loop; `retry` waits a poll
 * interval and re-evaluates (until the deadline); `fail` aborts.
 */
type SlotPollOutcome = { kind: 'done' } | { kind: 'retry' } | { kind: 'fail'; cause: unknown };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared poll-evaluate-until-deadline loop for the dapp-kit slot helpers.
 *
 * Factored out so `selectAccount` and `switchNetwork` can't drift on
 * retry/timeout semantics. Responsibilities owned here:
 *   - Run `evaluate` against the page, retrying on a destroyed JS
 *     execution context (a network/account switch can tear the context
 *     down mid-evaluate) until the deadline, then surfacing a typed
 *     error via `onContextTimeout`.
 *   - Hand each successful `evaluate` result to `classify`, which decides
 *     whether the loop is `done`, should `retry` (polling until the
 *     deadline), or has definitively `fail`ed.
 *
 * The caller owns *what* a result means (success/retry/failure) and how
 * to build its terminal errors; this helper owns the *when* (timing,
 * polling, context-loss recovery).
 */
const pollSlotUntilDeadline = async <T>(args: {
	readonly page: PlaywrightPageLike;
	readonly evaluate: (page: PlaywrightPageLike) => Promise<T>;
	readonly classify: (result: T, beforeDeadline: boolean) => SlotPollOutcome;
	readonly onContextTimeout: (lastEvaluateError: unknown) => PlaywrightWalletAdapterError;
	readonly onFail: (cause: unknown) => PlaywrightWalletAdapterError;
}): Promise<void> => {
	const deadline = Date.now() + SELECT_ACCOUNT_SLOT_TIMEOUT_MS;
	let lastEvaluateError: unknown;
	for (;;) {
		let result: T;
		try {
			result = await args.evaluate(args.page);
		} catch (cause) {
			// A network/account switch can destroy the JS execution context
			// mid-evaluate ("Execution context was destroyed"); the raw
			// rejection is transient, so retry until the deadline rather than
			// letting it escape as a flaky failure.
			lastEvaluateError = cause;
			if (Date.now() < deadline) {
				await sleep(SELECT_ACCOUNT_SLOT_POLL_MS);
				continue;
			}
			throw args.onContextTimeout(lastEvaluateError);
		}

		const outcome = args.classify(result, Date.now() < deadline);
		if (outcome.kind === 'done') return;
		if (outcome.kind === 'retry') {
			await sleep(SELECT_ACCOUNT_SLOT_POLL_MS);
			continue;
		}
		throw args.onFail(outcome.cause);
	}
};

/**
 * Connect/switch the app's active dev-wallet account through the dapp-kit
 * slot the app populates at boot.
 *
 * This intentionally avoids driving the wallet UI. The app-side slot
 * implementation still goes through dapp-kit + wallet-standard, so pairing,
 * origin, and account discovery failures surface as real browser failures.
 */
export const connectAs = async (page: PlaywrightPageLike, accountName: string): Promise<void> => {
	try {
		await selectAccount(page, accountName);
	} catch (cause) {
		throw new PlaywrightWalletAdapterError({
			message: `connectAs("${accountName}") failed`,
			operation: 'switch-account',
			cause,
		});
	}
};

/**
 * Switch the dev-wallet's active account by routing through the
 * dapp-kit global slot the app populates at module init. Strictly
 * faster + less flaky than clicking the wallet's UI.
 */
export const selectAccount = async (
	page: PlaywrightPageLike,
	accountName: string,
): Promise<void> => {
	// `evaluate`'s closure is serialized into the browser; the slot
	// shape (`DAppKitSlot`) lives in `runtime/dapp-kit-slot.ts` — the
	// in-browser closure can't import it, but the global-augmentation
	// `globalThis.__devstackDAppKit__` is the typed contract both sides
	// rely on.
	await pollSlotUntilDeadline<{ ok: boolean; reason?: string }>({
		page,
		// `await` here collapses the page-bridge's nested promise (the browser
		// function is async) so the callback resolves to the awaited result.
		evaluate: async (p) =>
			await p.evaluate(async (name): Promise<{ ok: boolean; reason?: string }> => {
				const slot = (globalThis as { __devstackDAppKit__?: DAppKitSlot }).__devstackDAppKit__;
				if (slot === undefined || slot.selectAccount === undefined) {
					return { ok: false, reason: 'slot-not-populated' };
				}
				try {
					await slot.selectAccount(name as string);
					return { ok: true };
				} catch (err) {
					return {
						ok: false,
						reason: err instanceof Error ? err.message : String(err),
					};
				}
			}, accountName),
		classify: (result, beforeDeadline) => {
			if (result.ok) return { kind: 'done' };
			if (result.reason === 'slot-not-populated' && beforeDeadline) return { kind: 'retry' };
			return { kind: 'fail', cause: result.reason };
		},
		onContextTimeout: (lastEvaluateError) =>
			new PlaywrightWalletAdapterError({
				message:
					`selectAccount("${accountName}") failed: page evaluation did not settle before ` +
					`${SELECT_ACCOUNT_SLOT_TIMEOUT_MS}ms. Confirm the app finished loading before ` +
					`calling connectAs().`,
				operation: 'switch-account',
				cause: lastEvaluateError,
			}),
		onFail: (cause) =>
			new PlaywrightWalletAdapterError({
				message:
					`selectAccount("${accountName}") failed: ${(cause as string | undefined) ?? 'unknown'}. ` +
					`Confirm \`globalThis.${DAPP_KIT_SLOT}\` is populated by the app's ` +
					`dapp-kit module at boot.`,
				operation: 'switch-account',
				// `cause` survives the `page.evaluate` boundary as a string —
				// the browser-side `Error` instance is lost across the bridge,
				// but the message is the load-bearing diagnostic. Preserving
				// it on the typed error keeps the underlying detail attached
				// when consumers inspect `cause` rather than `message`.
				cause,
			}),
	});
};

/**
 * Switch the app's active dApp Kit network through the same dapp-kit slot
 * `selectAccount` uses — one level over (network instead of account). Drives
 * dApp Kit's public `switchNetwork`; the dev wallet (registered once via
 * wallet-standard) stays mounted across the switch — only the active
 * network/client changes.
 *
 * Resolution semantics:
 *   - When the app exposes `currentNetwork`, resolves once the slot reports
 *     the current network is `network` (the switch deterministically took
 *     effect).
 *   - When it does NOT, there is no post-switch confirmation signal, so the
 *     helper lets the swap settle (see `SWITCH_NETWORK_UNCONFIRMED_SETTLE_MS`)
 *     rather than resolving the instant `switchNetwork()` returns `ok`.
 */
// When the app's slot does not expose `currentNetwork`, the helper has no
// post-switch signal to confirm the client swap propagated. Resolving the
// instant `switchNetwork()` returns `ok` (before the swap settles) produces
// flaky stale reads. Without a confirmation source we instead let the swap
// settle: keep re-confirming the slot reports `ok` across this window before
// accepting success. This is best-effort — apps that want a crisp signal
// should expose `currentNetwork` so the switch is confirmed deterministically.
const SWITCH_NETWORK_UNCONFIRMED_SETTLE_MS = 250;

export const switchNetwork = async (page: PlaywrightPageLike, network: string): Promise<void> => {
	// Tracks the first tick on which an unconfirmable switch (no
	// `currentNetwork` exposed) reported `ok`, so we can require the swap to
	// hold `ok` for a settle window rather than returning on the first tick.
	let unconfirmedOkSince: number | undefined;
	await pollSlotUntilDeadline<{ ok: boolean; reason?: string; current?: string }>({
		page,
		// `await` here collapses the page-bridge's nested promise (the browser
		// function is async) so the callback resolves to the awaited result.
		evaluate: async (p) =>
			await p.evaluate(async (net): Promise<{ ok: boolean; reason?: string; current?: string }> => {
				const slot = (globalThis as { __devstackDAppKit__?: DAppKitSlot }).__devstackDAppKit__;
				if (slot === undefined || slot.switchNetwork === undefined) {
					return { ok: false, reason: 'slot-not-populated' };
				}
				try {
					await slot.switchNetwork(net as string);
					return { ok: true, current: slot.currentNetwork?.() };
				} catch (err) {
					return { ok: false, reason: err instanceof Error ? err.message : String(err) };
				}
			}, network),
		classify: (result, beforeDeadline) => {
			if (result.ok && result.current === network) return { kind: 'done' };
			// No `currentNetwork` to confirm against — accept `ok`, but only
			// after it has held across the settle window so the client swap has
			// a real chance to propagate before downstream reads.
			if (result.ok && result.current === undefined) {
				const now = Date.now();
				unconfirmedOkSince ??= now;
				if (now - unconfirmedOkSince >= SWITCH_NETWORK_UNCONFIRMED_SETTLE_MS) {
					return { kind: 'done' };
				}
				return beforeDeadline ? { kind: 'retry' } : { kind: 'done' };
			}
			// `slot-not-populated`, or switched-but-not-yet-propagated
			// (`ok` with a stale `current`): keep polling until the deadline.
			if ((result.reason === 'slot-not-populated' || result.ok) && beforeDeadline) {
				return { kind: 'retry' };
			}
			return {
				kind: 'fail',
				cause: result.reason ?? `current is "${result.current}"`,
			};
		},
		onContextTimeout: (lastEvaluateError) =>
			new PlaywrightWalletAdapterError({
				message:
					`switchNetwork("${network}") failed: page evaluation did not settle before ` +
					`${SELECT_ACCOUNT_SLOT_TIMEOUT_MS}ms. Confirm the app finished loading and ` +
					`\`globalThis.${DAPP_KIT_SLOT}\` is populated.`,
				operation: 'switch-network',
				cause: lastEvaluateError,
			}),
		onFail: (cause) =>
			new PlaywrightWalletAdapterError({
				message:
					`switchNetwork("${network}") failed: ${(cause as string | undefined) ?? 'unknown'}. ` +
					`Confirm the network is in the app's deployment (a committed deployments/${network}.ts ` +
					`or the live local stack) and \`globalThis.${DAPP_KIT_SLOT}\` is populated.`,
				operation: 'switch-network',
				cause,
			}),
	});
};

// -----------------------------------------------------------------------------
// Artifact loaders
// -----------------------------------------------------------------------------

/** Test-side accessor for the full manifest (already decoded). */
export const loadStackManifest = (options: ResolveStackContextOptions = {}): StackContext =>
	readStackContext(options);
