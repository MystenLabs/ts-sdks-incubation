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

import { Schema } from 'effect';

import { BUILT_IN_ENDPOINT_ALIASES } from '../runtime/conventional-routes.ts';
import { discoverSingleStackManifestPath } from '../runtime/discover.ts';
import { resolveDiscoveryEnv } from '../runtime/resolve-discovery-env.ts';
import { WALLET_ENDPOINT_KEY } from '../runtime/wallet-paths.ts';
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
	// Shared ladder (option > DEVSTACK_RUNTIME_ROOT > DEVSTACK_STATE_DIR
	// > '.devstack'), resolved via `resolveDiscoveryEnv`. The single-stack
	// walk only needs the state-dir rung; stack is ignored.
	const { stateDir } = resolveDiscoveryEnv(
		env,
		options.stateDir !== undefined ? { stateDir: options.stateDir } : {},
	);
	return discoverSingleStackManifestPath({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		stateDir,
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
 * Per-poll state for tail-following `events.ndjson`. We keep an open
 * file descriptor across polls and `readSync` only the bytes appended
 * since the previous tick. Re-opening every 100ms (the default poll
 * cadence) burned ~3000 syscalls per 5min wait; the open-once tail
 * collapses that to one open + one close at the bracket. Two cross-poll
 * counters track the latest `endpoint.registered name=app` and
 * `codegen.emitted` line numbers — codegen is fresh only when its
 * latest sighting is AFTER the latest app-endpoint registration (a
 * restart re-registers the endpoint, invalidating an earlier codegen).
 *
 * Lifecycle: `openCodegenWatch` allocates the fd; `advanceCodegenWatch`
 * reads forward; `closeCodegenWatch` releases. The caller MUST close
 * (the `waitForReadyStackContext` finally-block does this even on
 * timeout / exception paths).
 */
interface CodegenWatchState {
	fd: number | null;
	offset: number;
	lineIndex: number;
	carry: string;
	latestAppEndpointLine: number;
	latestCodegenLine: number;
	lastFileSize: number;
	decodeFailures: number;
}

const createCodegenWatchState = (): CodegenWatchState => ({
	fd: null,
	offset: 0,
	lineIndex: 0,
	carry: '',
	latestAppEndpointLine: -1,
	latestCodegenLine: -1,
	lastFileSize: 0,
	decodeFailures: 0,
});

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Pinned-shape schema for the ndjson records we tail. The supervisor
 * emits a richer envelope (`protocol`/`seq`/`at` plus the full
 * `EngineEvent` union payload — see
 * `substrate/runtime/cross-process/command-channel/protocol.ts`
 * `EventRecordSchema`), but the watch only needs the discriminators
 * that route a record to `latestAppEndpointLine` / `latestCodegenLine`.
 *
 * The pin's job is to FAIL LOUDLY if one of those discriminators is
 * renamed upstream — a silent miss leaves the matchers permanently
 * unfired and deadlocks global-setup at the 5min `readyTimeout`. An
 * earlier version declared every field as `optional(Unknown)`, which
 * defeats that entirely: a `kind`→`recordKind` rename decoded to
 * `undefined` instead of throwing, so the watch silently stalled. We
 * therefore pin the stable discriminators as REQUIRED while keeping the
 * genuinely-variable axis (the engine `tag` value) permissive:
 *
 *   - The engine variant requires `kind: 'engine'` (the literal value
 *     the matchers test against, verified at `channel.ts` `publishEvent`)
 *     and a required `event.tag` STRING. Renaming `kind`, its `'engine'`
 *     value, the `event` key, or the `tag` key all fail decode — these
 *     are the deadlock-class discriminators. The `tag` VALUE stays open,
 *     so future `EngineEvent` tag additions need no change here.
 *   - `event.endpoint` is optional (most engine tags carry no endpoint),
 *     but WHERE present its `name` is REQUIRED. Renaming `name` on an
 *     `endpoint.registered` record therefore fails decode rather than
 *     silently leaving `latestAppEndpointLine` unset.
 *   - `ack` / `error` envelopes carry no `event`; a dedicated variant
 *     absorbs them so the supervisor's correlation replies don't flood
 *     `decodeFailures`. They are never routed.
 *
 * Deliberately NOT permissive about an unknown `kind`: a brand-new
 * envelope kind fails decode. That is a rare, intentional protocol
 * change (and would be made alongside updating consumers), and failing
 * loudly here is the same drift signal the engine-value pin provides.
 */
const WatchedEngineRecordSchema = Schema.Struct({
	kind: Schema.Literal('engine'),
	event: Schema.Struct({
		tag: Schema.String,
		endpoint: Schema.optional(
			Schema.Struct({
				name: Schema.String,
			}),
		),
	}),
});

const WatchedReplyRecordSchema = Schema.Struct({
	kind: Schema.Literals(['ack', 'error']),
});

const WatchedRecordSchema = Schema.Union([WatchedEngineRecordSchema, WatchedReplyRecordSchema]);

type WatchedRecord = Schema.Schema.Type<typeof WatchedRecordSchema>;
type WatchedEngineRecord = Schema.Schema.Type<typeof WatchedEngineRecordSchema>;

/**
 * @internal Exported only so the through-surface test can assert the
 * drift-detection contract directly (a renamed discriminator must
 * THROW, not decode to `undefined`). Not part of the public API.
 */
export const decodeWatchedRecord = Schema.decodeUnknownSync(WatchedRecordSchema);

const isEngineRecord = (record: WatchedRecord): record is WatchedEngineRecord =>
	record.kind === 'engine';

const isAppEndpointRegistration = (record: WatchedRecord): boolean =>
	isEngineRecord(record) &&
	record.event.tag === 'endpoint.registered' &&
	record.event.endpoint?.name === BUILT_IN_ENDPOINT_ALIASES.app;

const isCodegenEmitted = (record: WatchedRecord): boolean =>
	isEngineRecord(record) && record.event.tag === 'codegen.emitted';

const DEBUG_ENABLED = (): boolean => process.env.DEVSTACK_PLAYWRIGHT_DEBUG === '1';

const debugLog = (message: string): void => {
	if (!DEBUG_ENABLED()) return;
	try {
		process.stderr.write(`[devstack/playwright] ${message}\n`);
	} catch {
		// stderr EPIPE — swallow; the debug channel is best-effort.
	}
};

const ingestNdjsonLine = (state: CodegenWatchState, line: string): void => {
	if (line.length === 0) return;
	state.lineIndex += 1;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// Partial / corrupt line — atomic-append from the supervisor can
		// land a half-flushed write between polls. Bump the counter so
		// repeated failures surface in debug mode (a steady stream means
		// the writer is malformed, not just race-y).
		state.decodeFailures += 1;
		if (state.decodeFailures <= 3 || state.decodeFailures % 50 === 0) {
			debugLog(
				`events.ndjson line ${state.lineIndex} failed JSON.parse (decodeFailures=${state.decodeFailures})`,
			);
		}
		return;
	}
	let record: WatchedRecord;
	try {
		record = decodeWatchedRecord(parsed);
	} catch (cause) {
		// Schema drift: the supervisor emitted a record that doesn't
		// fit the discriminator shape we pin against. Log so a future
		// engine refactor that renames `kind` / `event.tag` /
		// `event.endpoint.name` surfaces immediately instead of
		// silently stalling the codegen wait at the readyTimeout.
		state.decodeFailures += 1;
		if (state.decodeFailures <= 3 || state.decodeFailures % 50 === 0) {
			debugLog(
				`events.ndjson line ${state.lineIndex} failed Schema.decode (decodeFailures=${state.decodeFailures}): ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		return;
	}
	if (isAppEndpointRegistration(record)) {
		state.latestAppEndpointLine = state.lineIndex;
	}
	if (isCodegenEmitted(record)) {
		state.latestCodegenLine = state.lineIndex;
	}
};

/**
 * Advance the watch state by reading any bytes appended since the
 * previous poll. The fd is allocated lazily on the first poll (so a
 * file that doesn't yet exist isn't a hard error) and stays open across
 * polls until `closeCodegenWatch`. Returns `true` when the file has a
 * codegen-fresh state ready for caller continuation.
 *
 * Truncation/rotation: when `statSync(...).size < state.lastFileSize`
 * the file rotated. We close the old fd, reopen, and restart the
 * counters so the new tail's events aren't shadowed by stale
 * cross-poll state.
 */
const advanceCodegenWatch = (state: CodegenWatchState, eventsPath: string): boolean => {
	if (state.fd === null) {
		try {
			state.fd = openSync(eventsPath, 'r');
		} catch {
			return false;
		}
	}
	try {
		const size = statSync(eventsPath).size;
		if (size < state.lastFileSize) {
			// File was truncated / rotated — drop the stale fd and reopen
			// so we read the new tail from byte zero.
			try {
				closeSync(state.fd);
			} catch {
				// Best-effort close; the inode is gone anyway.
			}
			state.fd = null;
			state.offset = 0;
			state.lineIndex = 0;
			state.carry = '';
			state.latestAppEndpointLine = -1;
			state.latestCodegenLine = -1;
			state.lastFileSize = 0;
			try {
				state.fd = openSync(eventsPath, 'r');
			} catch {
				return false;
			}
		}
		state.lastFileSize = size;
		const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		while (state.offset < size) {
			const bytesRead = readSync(state.fd, buf, 0, READ_CHUNK_BYTES, state.offset);
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
		// Treat read errors as "no progress this poll"; the fd stays
		// open so the next tick retries from `state.offset`.
	}
	if (state.latestCodegenLine < 0) return false;
	if (state.latestAppEndpointLine < 0) return true;
	return state.latestCodegenLine > state.latestAppEndpointLine;
};

const closeCodegenWatch = (state: CodegenWatchState): void => {
	if (state.fd === null) return;
	try {
		closeSync(state.fd);
	} catch {
		// Best-effort — we're done with the file regardless.
	}
	state.fd = null;
};

const waitForReadyStackContext = async (
	options: DefineGlobalSetupOptions,
): Promise<StackContext> => {
	const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const intervalMs = options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;

	// Phase 1: poll for the manifest itself. The supervisor writes it
	// eagerly during boot, but Playwright's `webServer.command` race
	// can land us here before the file exists. Once we've decoded a
	// manifest, we pin to its location for the remainder of the wait —
	// re-decoding on every tick (default 100ms over 5min) costs
	// thousands of JSON+Schema decodes for no information gain.
	let ctx: StackContext | null = null;
	while (Date.now() <= deadline) {
		try {
			ctx = readContextForSetup(options);
			break;
		} catch (cause) {
			lastError = cause;
			await sleep(intervalMs);
		}
	}
	if (ctx === null) {
		throw new Error(
			`devstack manifest did not appear within ${timeoutMs}ms` +
				(lastError instanceof Error ? `: ${lastError.message}` : ''),
		);
	}

	// Phase 2: tail `events.ndjson` for the codegen-fresh signal. Only
	// the events file changes during this phase — the manifest path is
	// fixed once Phase 1 succeeds. The watch holds an open fd across
	// polls; we close it on every exit path (success, timeout, throw).
	const eventsPath = join(dirname(ctx.manifestPath), 'events.ndjson');
	const watchState = createCodegenWatchState();
	try {
		while (Date.now() <= deadline) {
			if (advanceCodegenWatch(watchState, eventsPath)) return ctx;
			lastError = new Error(
				`devstack has not emitted codegen yet; waiting on events next to ${ctx.manifestPath}`,
			);
			await sleep(intervalMs);
		}
	} finally {
		closeCodegenWatch(watchState);
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

/** Monotonic counter for fixture rotations within a single Node process.
 *  Survives across `stashStackContext` calls so a Playwright retry that
 *  re-runs global-setup stamps a fresh `generation` even though the
 *  module never reloads. */
let stashGeneration = 0;

const stashStackContext = (ctx: StackContext): void => {
	// Include alias keys in the stashed endpoints map so consumers
	// iterating `fixture.endpoints` see the same contract as callers
	// of `endpoint(alias)`. Without this, `fixture.endpoints['app']`
	// would miss while `ctx.endpoint('app')` resolves to `'dev'` —
	// the asymmetry surprises consumers reading the raw dict.
	const endpoints: Record<string, string> = Object.fromEntries(
		ctx.endpointNames.map((name) => [name, ctx.endpoint(name)]),
	);
	for (const [alias, canonical] of Object.entries(BUILT_IN_ENDPOINT_ALIASES)) {
		if (alias in endpoints) continue;
		const url = endpoints[canonical];
		if (url !== undefined) endpoints[alias] = url;
	}
	stashGeneration += 1;
	const fixture: PlaywrightStackFixture = {
		endpoints,
		walletEndpoint: ctx.endpointMaybe(WALLET_ENDPOINT_KEY),
		manifestPath: ctx.manifestPath,
		stack: ctx.manifest.identity.stack,
		app: ctx.manifest.identity.app,
		generation: stashGeneration,
	};
	// Surface a one-line advisory when we overwrite an existing slot —
	// a second populate means global-setup ran twice (Playwright retry
	// with `reuseExistingServer:false`, or operator wiring both
	// `globalSetup` and an inline preset boot). The previous fixture
	// may be pointing at a stack that has since been torn down, so any
	// helper that cached the prior reference would silently read stale
	// state. The bumped `generation` lets cache-holders detect the
	// rotation and re-fetch.
	const previous = globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	if (previous !== undefined) {
		try {
			process.stderr.write(
				`[devstack/playwright] global-setup re-ran (generation ${previous.generation} → ${fixture.generation}); ` +
					`downstream consumers should re-read globalThis[${PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY}].\n`,
			);
		} catch {
			// stderr EPIPE — swallow; the warning is best-effort.
		}
	}
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = fixture;
};

/** Read the slot. Returns `null` if global-setup didn't run (e.g. the
 *  user opted out by passing `globalSetup: null`). */
export const readStashedFixture = (): PlaywrightStackFixture | null =>
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] ?? null;
