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
	const timeoutMs = options.timeoutMs ?? 5_000;

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
	const result = await page.evaluate(async (name): Promise<{ ok: boolean; reason?: string }> => {
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
	}, accountName);
	if (!result.ok) {
		throw new PlaywrightWalletAdapterError({
			message:
				`selectAccount("${accountName}") failed: ${result.reason ?? 'unknown'}. ` +
				`Confirm \`globalThis.${DAPP_KIT_SLOT}\` is populated by the app's ` +
				`dapp-kit module at boot.`,
			operation: 'switch-account',
			// `cause` survives the `page.evaluate` boundary as a string —
			// the browser-side `Error` instance is lost across the bridge,
			// but the message is the load-bearing diagnostic. Preserving
			// it on the typed error keeps the underlying detail attached
			// when consumers inspect `cause` rather than `message`.
			cause: result.reason,
		});
	}
};

// -----------------------------------------------------------------------------
// Artifact loaders
// -----------------------------------------------------------------------------

/** Test-side accessor for the full manifest (already decoded). */
export const loadStackManifest = (options: ResolveStackContextOptions = {}): StackContext =>
	readStackContext(options);
