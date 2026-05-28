// Playwright `globalSetup` hook.
//
// Architecture (distilled/23-build-integrations.md § Playwright):
//
//   What it needs: the same manifest as Vite (...) but with a
//   cold-start fallback (...) — Playwright config-load runs BEFORE
//   the supervisor spawns to write the manifest.
//
//   How it hooks in: the spawned `pnpm dev` (default `command`) brings
//   up the supervisor, which writes the real manifest. Playwright
//   polls `webServer.url` until reachable.
//
// This module is the third hook in that chain (config-load → webServer
// spawn → globalSetup). The public route can become reachable before
// post-acquire codegen has finished, so globalSetup waits for the
// supervisor's `codegen.emitted` event before specs load the app. That
// keeps apps from importing stale generated package IDs.
//
// What it does NOT do:
//   - Boot the supervisor. (`webServer.command` does that.)
//   - Wait on `webServer.url`. (Playwright does that.)
//   - Write any state. (Read-only.)
//
// Returns a teardown function (the inverse hook Playwright supports
// via `globalTeardown` indirection — we return the teardown so the
// preset's `globalTeardown` can call it).

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BUILT_IN_ENDPOINT_ALIASES } from '../runtime/conventional-routes.ts';
import { discoverSingleStackManifestPath } from '../runtime/discover.ts';
import {
	PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY,
	type PlaywrightStackFixture as RuntimePlaywrightStackFixture,
} from '../runtime/playwright-stack-context-slot.ts';
import {
	PLAYWRIGHT_ENV,
	readStackContext,
	type ResolveStackContextOptions,
	type StackContext,
} from './stack-context.ts';
import { PlaywrightManifestDiscoveryError } from './errors.ts';

// -----------------------------------------------------------------------------
// Public shape Playwright expects
// -----------------------------------------------------------------------------

/** Playwright's `globalSetup` signature is `() => Promise<void | (() =>
 *  Promise<void>)>` — we model it explicitly so the preset compiles
 *  without `@playwright/test`. */
export type PlaywrightGlobalSetup = () => Promise<void | (() => Promise<void>)>;

// -----------------------------------------------------------------------------
// Fixture payload
// -----------------------------------------------------------------------------

/**
 * The shape global-setup writes for in-spec tests to read. Tests do
 * NOT re-walk-up to find the manifest at every assertion — they read
 * this prepared fixture from `globalThis`, which is faster and avoids
 * a subtle cwd-mismatch class of failure when Playwright runs tests
 * from a worker process.
 *
 * Re-export of the substrate-owned `runtime/playwright-stack-context-slot`
 * shape so both consumer surfaces agree on one type. The matching
 * typed `declare global` block lives next to the slot key so callers
 * can read/write `globalThis[KEY]` without a cast.
 */
export type PlaywrightStackFixture = RuntimePlaywrightStackFixture;

// -----------------------------------------------------------------------------
// Configurable factory
// -----------------------------------------------------------------------------

export interface DefineGlobalSetupOptions extends ResolveStackContextOptions {
	/**
	 * Wait for the supervisor's post-acquire codegen event before the
	 * browser loads the app. Default: `true`.
	 */
	readonly waitForCodegen?: boolean;

	/** Maximum wait for the manifest + codegen-ready event. */
	readonly readyTimeoutMs?: number;

	/** Poll interval while waiting for the manifest + codegen-ready event. */
	readonly readyPollIntervalMs?: number;

	/**
	 * Verify the manifest's `endpoints` has at least one entry. The
	 * supervisor's manifest writer always emits at least the `app`
	 * endpoint, so an empty `endpoints` lookup means the supervisor
	 * crashed before reaching its eager snapshot-and-write — fail
	 * fast here rather than letting tests time out.
	 */
	readonly requireNonEmptyEndpoints?: boolean;

	/**
	 * Verify the named endpoints exist in the manifest. Used to fail
	 * fast when a test suite depends on a specific plugin (wallet,
	 * sui-faucet) being present in the resolved stack.
	 */
	readonly requireEndpoints?: ReadonlyArray<string>;

	/**
	 * Pre-warm the stack context — read the manifest once and stash
	 * the result on `globalThis` so tests don't repeat the disk read.
	 * Default: `true`.
	 */
	readonly preloadContext?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 300_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const stackOptionWasExplicit = (options: DefineGlobalSetupOptions): boolean => {
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	return (
		options.stack !== undefined ||
		options.manifestPath !== undefined ||
		env[PLAYWRIGHT_ENV.STACK] !== undefined ||
		env[PLAYWRIGHT_ENV.MANIFEST_PATH] !== undefined
	);
};

const findSingleStackManifestPath = (options: DefineGlobalSetupOptions): string | null => {
	if (stackOptionWasExplicit(options)) return null;
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const stateDir = options.stateDir ?? env[PLAYWRIGHT_ENV.STATE_DIR];
	return discoverSingleStackManifestPath({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(stateDir !== undefined && stateDir !== '' ? { stateDir } : {}),
	});
};

const readContextForSetup = (options: DefineGlobalSetupOptions): StackContext => {
	try {
		return readStackContext(options);
	} catch (cause) {
		if (!(cause instanceof PlaywrightManifestDiscoveryError)) throw cause;
		const inferredManifestPath = findSingleStackManifestPath(options);
		if (inferredManifestPath === null) throw cause;
		return readStackContext({ ...options, manifestPath: inferredManifestPath });
	}
};

/**
 * Per-poll state for tail-following `events.ndjson`. We read only the
 * bytes appended since the previous poll, then carry forward an
 * unterminated trailing partial line until the next call. Two
 * cross-poll counters track the latest `endpoint.registered name=app`
 * and `codegen.emitted` line numbers — codegen is fresh only when its
 * latest sighting is AFTER the latest app-endpoint registration (a
 * restart re-registers the endpoint, invalidating an earlier codegen).
 */
interface CodegenWatchState {
	offset: number;
	lineIndex: number;
	carry: string;
	latestAppEndpointLine: number;
	latestCodegenLine: number;
	lastFileSize: number;
}

const createCodegenWatchState = (): CodegenWatchState => ({
	offset: 0,
	lineIndex: 0,
	carry: '',
	latestAppEndpointLine: -1,
	latestCodegenLine: -1,
	lastFileSize: 0,
});

const READ_CHUNK_BYTES = 64 * 1024;

const ingestNdjsonLine = (state: CodegenWatchState, line: string): void => {
	if (line.length === 0) return;
	state.lineIndex += 1;
	try {
		const record = JSON.parse(line) as {
			readonly kind?: unknown;
			readonly event?: {
				readonly tag?: unknown;
				readonly endpoint?: { readonly name?: unknown };
			};
		};
		if (
			record.kind === 'engine' &&
			record.event?.tag === 'endpoint.registered' &&
			record.event.endpoint?.name === BUILT_IN_ENDPOINT_ALIASES.app
		) {
			state.latestAppEndpointLine = state.lineIndex;
		}
		if (record.kind === 'engine' && record.event?.tag === 'codegen.emitted') {
			state.latestCodegenLine = state.lineIndex;
		}
	} catch {
		// Ignore partial / corrupt lines — atomic-append from the
		// supervisor can land a half-flushed write between polls.
	}
};

/**
 * Advance the watch state by reading any bytes appended since the
 * previous poll. The file is opened, sized, and read in chunks from
 * the saved offset; an unterminated trailing partial is held in
 * `state.carry` for the next call. Returns `true` when the file has
 * a codegen-fresh state ready for caller continuation.
 */
const advanceCodegenWatch = (state: CodegenWatchState, eventsPath: string): boolean => {
	let fd: number;
	try {
		fd = openSync(eventsPath, 'r');
	} catch {
		return false;
	}
	try {
		const size = statSync(eventsPath).size;
		if (size < state.lastFileSize) {
			// File was truncated / rotated — restart from the top so we
			// don't miss the new tail's events.
			state.offset = 0;
			state.lineIndex = 0;
			state.carry = '';
			state.latestAppEndpointLine = -1;
			state.latestCodegenLine = -1;
		}
		state.lastFileSize = size;
		const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		while (state.offset < size) {
			const bytesRead = readSync(fd, buf, 0, READ_CHUNK_BYTES, state.offset);
			if (bytesRead <= 0) break;
			state.offset += bytesRead;
			const chunk = state.carry + buf.subarray(0, bytesRead).toString('utf8');
			const segments = chunk.split(/\r?\n/);
			state.carry = segments.pop() ?? '';
			for (const segment of segments) {
				ingestNdjsonLine(state, segment);
			}
		}
	} catch {
		// Treat read errors as "no progress this poll".
	} finally {
		closeSync(fd);
	}
	if (state.latestCodegenLine < 0) return false;
	if (state.latestAppEndpointLine < 0) return true;
	return state.latestCodegenLine > state.latestAppEndpointLine;
};

const waitForReadyStackContext = async (
	options: DefineGlobalSetupOptions,
): Promise<StackContext> => {
	const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const intervalMs = options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;
	const watchState = createCodegenWatchState();
	let watchManifestPath: string | null = null;

	while (Date.now() <= deadline) {
		try {
			const ctx = readContextForSetup(options);
			const eventsPath = join(dirname(ctx.manifestPath), 'events.ndjson');
			// Restart the offset tracker when the resolved manifest path
			// flips (single-stack discovery fallback can land on a
			// different stack on the second try if the runtime root
			// produced a new sibling between polls).
			if (watchManifestPath !== eventsPath) {
				watchManifestPath = eventsPath;
				watchState.offset = 0;
				watchState.lineIndex = 0;
				watchState.carry = '';
				watchState.latestAppEndpointLine = -1;
				watchState.latestCodegenLine = -1;
				watchState.lastFileSize = 0;
			}
			if (advanceCodegenWatch(watchState, eventsPath)) return ctx;
			lastError = new Error(
				`devstack has not emitted codegen yet; waiting on events next to ${ctx.manifestPath}`,
			);
		} catch (cause) {
			lastError = cause;
		}
		await sleep(intervalMs);
	}

	throw new Error(
		`devstack did not reach post-acquire codegen within ${timeoutMs}ms` +
			(lastError instanceof Error ? `: ${lastError.message}` : ''),
	);
};

/**
 * Build a Playwright `globalSetup` function. The returned function
 * matches the signature Playwright expects (a default export of a
 * module path; we return the function so the preset can wire it).
 */
export const buildGlobalSetup = (options: DefineGlobalSetupOptions = {}): PlaywrightGlobalSetup => {
	return async () => {
		const ctx =
			(options.waitForCodegen ?? true)
				? await waitForReadyStackContext(options)
				: readContextForSetup(options);

		if (options.requireNonEmptyEndpoints === true) {
			if (ctx.endpointNames.length === 0) {
				throw new Error(
					`devstack manifest at ${ctx.manifestPath} has no endpoints. ` +
						`The supervisor likely failed before its eager snapshot ` +
						`write; check the dev server logs for plugin acquire errors.`,
				);
			}
		}

		const required = options.requireEndpoints ?? [];
		const missing: string[] = [];
		for (const key of required) {
			if (ctx.endpointMaybe(key) === null) missing.push(key);
		}
		if (missing.length > 0) {
			throw new Error(
				`devstack manifest at ${ctx.manifestPath} is missing required ` +
					`endpoints: ${missing.join(', ')}. ` +
					`available endpoint names: ${ctx.endpointNames.join(', ') || '(none)'}. ` +
					`raw manifest keys: ${ctx.manifestEndpointKeys.join(', ') || '(none)'}.`,
			);
		}

		if (options.preloadContext ?? true) {
			stashStackContext(ctx);
		}

		// Return value: `void` (no teardown). Playwright accepts
		// `() => Promise<void>` here.
	};
};

/** Default export shape that mirrors what Playwright's
 *  `defineConfig.globalSetup` resolves: a module whose default export
 *  is the setup function. */
export default buildGlobalSetup();

// -----------------------------------------------------------------------------
// Global stash
// -----------------------------------------------------------------------------

/** The slot on `globalThis` where the prewarmed stack context lives.
 *  In-spec helpers (`wallet-context.ts`) read from here when present
 *  to avoid a second disk read. Re-exported from the runtime slot
 *  module so consumers can import either side. */
export const STACK_CONTEXT_SLOT = PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY;

const stashStackContext = (ctx: StackContext): void => {
	const fixture: PlaywrightStackFixture = {
		endpoints: Object.fromEntries(ctx.endpointNames.map((name) => [name, ctx.endpoint(name)])),
		walletEndpoint: ctx.endpointMaybe('wallet'),
		manifestPath: ctx.manifestPath,
		stack: ctx.manifest.identity.stack,
		app: ctx.manifest.identity.app,
	};
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = fixture;
};

/** Read the slot. Returns `null` if global-setup didn't run (e.g. the
 *  user opted out by passing `globalSetup: null`). */
export const readStashedFixture = (): PlaywrightStackFixture | null =>
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] ?? null;
