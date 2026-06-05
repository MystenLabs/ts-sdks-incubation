// Playwright `globalSetup` — through-surface tests.
//
// The interesting machinery (`advanceCodegenWatch`, `readContextForSetup`,
// the codegen-fresh ordering invariant, the require* fast-fails) is
// module-private. We drive it through the public `buildGlobalSetup`
// factory against a real on-disk manifest + a hand-written
// `events.ndjson`, with short poll/timeout knobs so the codegen-wait
// path completes (or fails fast) without a live supervisor or browser.
//
// Browser-only surface NOT covered here: nothing — global-setup is
// deliberately browser-free (it reads disk + tails ndjson and returns
// void). The only thing we cannot drive deterministically through the
// public API is the mid-poll truncation reopen (it requires mutating
// the file *between* two 1ms polls); we cover the truncation/rotation
// LOGIC via the codegen-staleness ordering invariant, which exercises
// the same cross-poll line counters.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	buildGlobalSetup,
	decodeWatchedRecord,
} from '../../../src/build-integrations/playwright/global-setup.ts';
import { PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY } from '../../../src/build-integrations/runtime/playwright-stack-context-slot.ts';
import { CURRENT_MANIFEST_VERSION } from '../../../src/substrate/runtime/manifest/manifest.ts';
import { withTempRootAsync } from '../../helpers/with-temp-root.ts';

const sampleEnvelope = (overrides?: { endpoints?: Record<string, unknown> }) => ({
	identity: { app: 'sample-app', stack: 'main', chain: 'localnet' },
	manifestVersion: CURRENT_MANIFEST_VERSION,
	services: {},
	endpoints: overrides?.endpoints ?? {
		'host-service/app#5:dev': {
			name: 'dev',
			url: 'http://main.app.localhost:8000',
			displayUrl: 'http://main.app.localhost:8000',
			wireProtocol: 'http',
			pluginKey: 'host-service/app#5',
			endpointKey: 'host-service/app#5:dev',
		},
	},
	extras: {},
});

/** Write a manifest into a `.devstack/stacks/<stack>/manifest.json`
 *  layout under `root` and return both the manifest path and the
 *  sibling `events.ndjson` path (where global-setup tails). */
const writeStack = (
	root: string,
	stack = 'main',
	envelope: unknown = sampleEnvelope(),
): { readonly manifestPath: string; readonly eventsPath: string } => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, 'manifest.json');
	writeFileSync(manifestPath, JSON.stringify(envelope));
	return { manifestPath, eventsPath: join(dir, 'events.ndjson') };
};

/** NDJSON line shaped like the supervisor's engine-event envelope, with
 *  the `kind` / `event.tag` / `event.endpoint.name` discriminators the
 *  watch pins against. */
const engineLine = (tag: string, endpointName?: string): string =>
	JSON.stringify({
		kind: 'engine',
		event: {
			tag,
			...(endpointName !== undefined ? { endpoint: { name: endpointName } } : {}),
		},
	});

// `BUILT_IN_ENDPOINT_ALIASES.app === 'dev'` — the watch keys off the
// CANONICAL app endpoint name, which is `'dev'`.
const APP_ENDPOINT_NAME = 'dev';

const writeEvents = (eventsPath: string, lines: ReadonlyArray<string>): void => {
	writeFileSync(eventsPath, lines.length === 0 ? '' : lines.join('\n') + '\n');
};

const SHORT = { readyTimeoutMs: 400, readyPollIntervalMs: 1 } as const;

describe('buildGlobalSetup — codegen-fresh ordering invariant', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('resolves once codegen.emitted lands AFTER the app endpoint registration', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			// app registered, THEN codegen emitted → fresh.
			writeEvents(eventsPath, [
				engineLine('endpoint.registered', APP_ENDPOINT_NAME),
				engineLine('codegen.emitted'),
			]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).resolves.toBeUndefined();

			const fixture = globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
			expect(fixture?.manifestPath).toBe(manifestPath);
			expect(fixture?.endpoints.app).toBe('http://main.app.localhost:8000');
		});
	});

	it('does NOT treat a codegen that predates the latest app re-registration as fresh (times out)', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			// codegen, then a LATER app re-registration (restart) invalidates
			// it — the watch must keep waiting and ultimately time out.
			writeEvents(eventsPath, [
				engineLine('endpoint.registered', APP_ENDPOINT_NAME),
				engineLine('codegen.emitted'),
				engineLine('endpoint.registered', APP_ENDPOINT_NAME),
			]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).rejects.toThrow(/post-acquire codegen/u);
		});
	});

	it('resolves when codegen is seen and NO app endpoint registration is present', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			// `latestAppEndpointLine < 0` branch: a codegen sighting with no
			// app-registration line is treated as fresh.
			writeEvents(eventsPath, [engineLine('codegen.emitted')]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).resolves.toBeUndefined();
		});
	});

	it('tolerates corrupt / partial ndjson lines without stalling', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			writeEvents(eventsPath, [
				'{ this is not valid json',
				engineLine('endpoint.registered', APP_ENDPOINT_NAME),
				engineLine('codegen.emitted'),
			]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).resolves.toBeUndefined();
		});
	});

	it('times out when codegen never arrives', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			writeEvents(eventsPath, [engineLine('endpoint.registered', APP_ENDPOINT_NAME)]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).rejects.toThrow(/post-acquire codegen/u);
		});
	});

	it('times out when the events file is absent (open fails every poll)', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root);
			// No events.ndjson written — `advanceCodegenWatch` openSync
			// fails each tick and the wait times out.
			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).rejects.toThrow(/post-acquire codegen/u);
		});
	});
});

// The pin's contract: a rename of a WATCHED discriminator
// (`kind` / `event.tag` / `event.endpoint.name`) must FAIL decode loudly
// rather than decode to `undefined`. The prior `optional(Unknown)` schema
// silently accepted such records, leaving the matchers unfired and
// deadlocking global-setup at the 5min readyTimeout. We assert the decode
// surface directly (the matcher routing keys off these exact fields) plus
// one end-to-end consequence: a renamed-discriminator stream times out.
describe('WatchedRecordSchema — drift detection (loud-fail contract)', () => {
	it('decodes the watched engine records (endpoint.registered + codegen.emitted)', () => {
		expect(() =>
			decodeWatchedRecord(JSON.parse(engineLine('endpoint.registered', APP_ENDPOINT_NAME))),
		).not.toThrow();
		expect(() => decodeWatchedRecord(JSON.parse(engineLine('codegen.emitted')))).not.toThrow();
	});

	it('tolerates ack / error reply envelopes (no event field) without throwing', () => {
		// The supervisor writes correlation replies onto the same
		// events.ndjson; they are never routed but must not flood
		// decodeFailures, so the schema absorbs them.
		expect(() =>
			decodeWatchedRecord({ kind: 'ack', correlatesTo: 'cmd-1', detail: 'ok' }),
		).not.toThrow();
		expect(() =>
			decodeWatchedRecord({ kind: 'error', correlatesTo: 'cmd-1', message: 'boom' }),
		).not.toThrow();
	});

	it('stays permissive about FUTURE engine tag values (open tag, additive-safe)', () => {
		// A not-yet-modelled engine tag must still decode — pinning the
		// tag VALUE would force a code change on every EngineEvent addition.
		expect(() =>
			decodeWatchedRecord({ kind: 'engine', event: { tag: 'some.future.tag', at: 1 } }),
		).not.toThrow();
	});

	it('THROWS when the top-level `kind` KEY is renamed (kind → recordKind)', () => {
		// The exact silent-stall regression from the bug: optional(Unknown)
		// decoded this to `{ kind: undefined }`; the required literal throws.
		expect(() =>
			decodeWatchedRecord({ recordKind: 'engine', event: { tag: 'codegen.emitted' } }),
		).toThrow();
	});

	it('THROWS when the `kind` VALUE is renamed (engine → eng)', () => {
		expect(() => decodeWatchedRecord({ kind: 'eng', event: { tag: 'codegen.emitted' } })).toThrow();
	});

	it('THROWS when the `event` KEY is renamed (event → payload)', () => {
		expect(() =>
			decodeWatchedRecord({ kind: 'engine', payload: { tag: 'codegen.emitted' } }),
		).toThrow();
	});

	it('THROWS when the `event.tag` KEY is renamed (tag → eventTag)', () => {
		expect(() =>
			decodeWatchedRecord({ kind: 'engine', event: { eventTag: 'codegen.emitted' } }),
		).toThrow();
	});

	it('THROWS when `event.endpoint.name` KEY is renamed on an endpoint.registered record', () => {
		// endpoint is optional across the engine-event union, but WHERE
		// present its `name` is required — a rename surfaces as a decode
		// failure instead of silently leaving latestAppEndpointLine unset.
		expect(() =>
			decodeWatchedRecord({
				kind: 'engine',
				event: { tag: 'endpoint.registered', endpoint: { label: APP_ENDPOINT_NAME } },
			}),
		).toThrow();
	});

	it('THROWS on a brand-new (unmodelled) envelope kind', () => {
		// Drift signal for a protocol-level change: a new envelope kind is
		// a deliberate change that must be made alongside updating consumers.
		expect(() => decodeWatchedRecord({ kind: 'heartbeat', at: 1 })).toThrow();
	});

	it('end-to-end: a stream of RENAMED-discriminator codegen lines deadlocks (times out)', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath, eventsPath } = writeStack(root);
			// Both the app-registration and codegen lines have `kind`
			// renamed. Under the old optional(Unknown) schema these decoded
			// silently and the matchers no-op'd; under the pin they fail
			// decode. EITHER way the codegen-fresh signal never fires, so
			// the wait must time out — this asserts the matchers don't fire
			// on drifted records (the loud-fail logs separately in debug).
			const renamedKind = (tag: string, endpointName?: string): string =>
				JSON.stringify({
					recordKind: 'engine',
					event: {
						tag,
						...(endpointName !== undefined ? { endpoint: { name: endpointName } } : {}),
					},
				});
			writeEvents(eventsPath, [
				renamedKind('endpoint.registered', APP_ENDPOINT_NAME),
				renamedKind('codegen.emitted'),
			]);

			const setup = buildGlobalSetup({ manifestPath, ...SHORT });
			await expect(setup()).rejects.toThrow(/post-acquire codegen/u);
		});
	});
});

describe('buildGlobalSetup — waitForCodegen opt-out', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('skips the events tail entirely and reads the manifest directly', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root);
			// No events.ndjson, but waitForCodegen:false bypasses the tail.
			const setup = buildGlobalSetup({ manifestPath, waitForCodegen: false });
			await expect(setup()).resolves.toBeUndefined();
			expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]?.manifestPath).toBe(manifestPath);
		});
	});
});

describe('buildGlobalSetup — require* fast-fail branches', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('requireNonEmptyEndpoints throws when the manifest has zero endpoints', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root, 'main', sampleEnvelope({ endpoints: {} }));
			const setup = buildGlobalSetup({
				manifestPath,
				waitForCodegen: false,
				requireNonEmptyEndpoints: true,
			});
			await expect(setup()).rejects.toThrow(/has no endpoints/u);
		});
	});

	it('requireEndpoints throws listing the missing endpoint names', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root);
			const setup = buildGlobalSetup({
				manifestPath,
				waitForCodegen: false,
				requireEndpoints: ['wallet', 'sui-faucet'],
			});
			await expect(setup()).rejects.toThrow(/missing required endpoints: wallet, sui-faucet/u);
		});
	});

	it('requireEndpoints passes when the named endpoint (via alias) is present', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root);
			// `'app'` aliases to the canonical `'dev'` endpoint present in
			// the sample manifest.
			const setup = buildGlobalSetup({
				manifestPath,
				waitForCodegen: false,
				requireEndpoints: ['app'],
			});
			await expect(setup()).resolves.toBeUndefined();
		});
	});

	it('preloadContext:false leaves the globalThis slot untouched', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			const { manifestPath } = writeStack(root);
			const setup = buildGlobalSetup({
				manifestPath,
				waitForCodegen: false,
				preloadContext: false,
			});
			await expect(setup()).resolves.toBeUndefined();
			expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]).toBeUndefined();
		});
	});
});

describe('buildGlobalSetup — cold-start single-stack manifest fallback', () => {
	beforeEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});
	afterEach(() => {
		delete globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	});

	it('readContextForSetup infers the lone stack when no explicit path/stack is given', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			// Single stack named something OTHER than the default `main`, so
			// the plain discover walk-up (which targets `main`) misses and
			// the single-stack fallback in `readContextForSetup` kicks in.
			const { manifestPath } = writeStack(root, 'only-one');
			const setup = buildGlobalSetup({ cwd: root, env: {}, waitForCodegen: false });
			await expect(setup()).resolves.toBeUndefined();
			expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]?.manifestPath).toBe(manifestPath);
		});
	});

	it('does NOT apply the single-stack fallback when a stack was explicitly requested', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			// Lone stack present but a DIFFERENT explicit stack requested →
			// `stackOptionWasExplicit` short-circuits the fallback, so the
			// read fails with the discovery error.
			writeStack(root, 'only-one');
			const setup = buildGlobalSetup({
				cwd: root,
				env: {},
				stack: 'main',
				waitForCodegen: false,
			});
			await expect(setup()).rejects.toThrow();
		});
	});

	it('does NOT apply the single-stack fallback when multiple stacks are ambiguous', async () => {
		await withTempRootAsync('pw-global-setup', async (root) => {
			writeStack(root, 'stack-a');
			writeStack(root, 'stack-b');
			const setup = buildGlobalSetup({ cwd: root, env: {}, waitForCodegen: false });
			await expect(setup()).rejects.toThrow();
		});
	});
});
