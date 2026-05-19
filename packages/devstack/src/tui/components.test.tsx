// Ink-component coverage for the TUI.
//
// `ink-testing-library`'s `render()` mounts the React tree into an
// in-memory writer and exposes `lastFrame()` + stdin emulation. That
// gives us deterministic snapshots without depending on a real TTY.
//
// We drive the engine via `EngineLive` from the real engine module so
// the production wiring (markReady / requestRestart / appendLog) is
// what these tests exercise — no parallel fake-engine class.

import { Context, Effect, Layer, Ref } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
import React from 'react';
import { EngineHandle, EngineLive, type EngineHandleShape } from '../engine/engine.js';
import { App } from './components.js';

const buildEngine = async (): Promise<EngineHandleShape> => {
	const ctx = await Effect.runPromise(Layer.build(EngineLive).pipe(Effect.scoped));
	return Context.get(ctx, EngineHandle);
};

// Lets the async polling effect inside `<App>` flush a snapshot into
// React state. 50ms is plenty when `pollIntervalMs` is set to 10.
const flush = async (ms = 50): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('App', () => {
	it('renders empty-state placeholder when no primitives are seeded', async () => {
		const engine = await buildEngine();
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('no primitives in stack');
		// Both `r` and `R` trigger full restart today (per-primitive retry
		// rolled back). Footer surfaces the available keybinds.
		expect(frame).toContain('[r]estart');
		expect(frame).toContain('[q]uit');
		unmount();
	});

	it('renders a service entry with title + primary URL + ready badge', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: '@devstack/Sui', kind: 'service' }]));
		await Effect.runPromise(engine.markAcquiring('@devstack/Sui', 'service'));
		await Effect.runPromise(
			engine.markReady('@devstack/Sui', {
				title: 'sui.localnet',
				primary: 'http://127.0.0.1:9000',
			}),
		);

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Services');
		expect(frame).toContain('localnet');
		expect(frame).toContain('http://127.0.0.1:9000');
		expect(frame).toContain('ready');
		unmount();
	});

	it('renders an action entry with the ready badge surfaced as "done"', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: 'publish-hello', kind: 'action' }]));
		await Effect.runPromise(engine.markAcquiring('publish-hello', 'action'));
		await Effect.runPromise(
			engine.markReady('publish-hello', {
				title: 'publish.hello',
				primary: '0xabc…123',
				extras: ['upgrade-cap 0xfed…456'],
			}),
		);

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Actions');
		expect(frame).toContain('hello');
		expect(frame).toContain('0xabc…123');
		expect(frame).toContain('done');
		expect(frame).toContain('upgrade-cap 0xfed…456');
		unmount();
	});

	it('actions section: three+ ready rows collapse into one compact summary line', async () => {
		// The wallet stack's actions section can crowd the dashboard with
		// publishMove + Action + pool-init rows. Once they're all `done`,
		// the section folds into a single `done (N): name1, name2, …` line
		// so steady-state stacks read at a glance.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([
				{ key: 'publish.mock_usdc', kind: 'action' },
				{ key: 'publish.mock_weth', kind: 'action' },
				{ key: 'tx.seedTokens', kind: 'action' },
			]),
		);
		for (const k of ['publish.mock_usdc', 'publish.mock_weth', 'tx.seedTokens']) {
			await Effect.runPromise(engine.markAcquiring(k, 'action'));
			await Effect.runPromise(engine.markReady(k, { title: k.replace(/\./, '.') }));
		}
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Actions');
		expect(frame).toContain('done (3)');
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('mock_usdc');
		expect(normalized).toContain('mock_weth');
		expect(normalized).toContain('seedTokens');
		// `done` appears once in the summary cell, NOT three times as
		// individual row status words.
		expect(frame.match(/\bdone\b/g)?.length ?? 0).toBe(1);
		unmount();
	});

	it('actions section: an endpoint-bearing row is excluded from the collapse', async () => {
		// Multi-endpoint primitives (walrus aggregator/publisher; future
		// seal multi-server) carry URLs the user needs visible at all
		// times. The collapse pool ignores rows whose `endpoints` are
		// non-empty so a "compact" run of done actions doesn't hide
		// the only URL on the dashboard.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([
				{ key: 'publish.a', kind: 'action' },
				{ key: 'publish.b', kind: 'action' },
				{ key: 'publish.c', kind: 'action' },
				{ key: 'publish.with-url', kind: 'action' },
			]),
		);
		for (const k of ['publish.a', 'publish.b', 'publish.c']) {
			await Effect.runPromise(engine.markAcquiring(k, 'action'));
			await Effect.runPromise(engine.markReady(k, { title: k }));
		}
		await Effect.runPromise(engine.markAcquiring('publish.with-url', 'action'));
		await Effect.runPromise(
			engine.markReady('publish.with-url', {
				title: 'publish.with-url',
				endpoints: [{ label: 'pub', url: 'http://endpoint.example.localhost:9000' }],
			}),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		// The three URL-less ready rows still collapse...
		expect(frame).toContain('done (3)');
		// ...but the endpoint-bearing row renders its URL on its own line.
		expect(frame).toContain('endpoint.example.localhost:9000');
		unmount();
	});

	it('actions section: in-flight row stays full while ready siblings collapse', async () => {
		// Failed/in-flight rows still need to surface their state — only the
		// done rows fold. This keeps the user's attention pinned on what's
		// actually happening without losing context about which siblings
		// already finished.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([
				{ key: 'publish.a', kind: 'action' },
				{ key: 'publish.b', kind: 'action' },
				{ key: 'publish.c', kind: 'action' },
				{ key: 'tx.slow', kind: 'action' },
			]),
		);
		await Effect.runPromise(engine.markAcquiring('publish.a', 'action'));
		await Effect.runPromise(engine.markReady('publish.a', { title: 'publish.a' }));
		await Effect.runPromise(engine.markAcquiring('publish.b', 'action'));
		await Effect.runPromise(engine.markReady('publish.b', { title: 'publish.b' }));
		await Effect.runPromise(engine.markAcquiring('publish.c', 'action'));
		await Effect.runPromise(engine.markReady('publish.c', { title: 'publish.c' }));
		// Leave `tx.slow` in acquiring with a phase set so it renders as a
		// full row.
		await Effect.runPromise(engine.markAcquiring('tx.slow', 'action'));
		await Effect.runPromise(engine.setPhase('tx.slow', 'executing'));

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('slow');
		expect(normalized).toContain('executing');
		expect(frame).toContain('done (3)');
		unmount();
	});

	it('failed entry surfaces the short error in the row and the full walk in the log tail', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: '@devstack/Sui', kind: 'service' }]));
		await Effect.runPromise(engine.markAcquiring('@devstack/Sui', 'service'));
		const { Cause } = await import('effect');
		const shortMsg = 'connect ECONNREFUSED 127.0.0.1:9000';
		await Effect.runPromise(engine.markFailed('@devstack/Sui', Cause.fail(new Error(shortMsg))));

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('failed');
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain(shortMsg);
		unmount();
	});

	it('header surfaces app/network/cycle and build status', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.setHeader({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				cycle: 2,
				buildStatus: 'running',
			}),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('arena');
		expect(frame).toContain('localnet (stack=main)');
		expect(frame).toContain('cycle 2');
		expect(frame).toContain('[running]');
		unmount();
	});

	it('detail column prefers lastLog over primary when both are set', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: 'sui.localnet', kind: 'service', title: 'sui.localnet' }]),
		);
		await Effect.runPromise(
			engine.markReady('sui.localnet', {
				title: 'sui.localnet',
				primary: 'http://127.0.0.1:9000',
			}),
		);
		await Effect.runPromise(
			engine.appendTagLog('sui.localnet', {
				ts: Date.now(),
				level: 'info',
				message: 'starting genesis',
			}),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('starting genesis');
		unmount();
	});

	it('q keypress invokes onQuit after the shutdown-feedback flush', async () => {
		// onQuit fires inside the q-handler AFTER setBuildStatus('shutting-down')
		// + appendLog. The 150ms hardcoded sleep is gone — the TUI mount
		// passes an `onFlush` callback that writes the engine snapshot
		// into stableState before `onQuit`. ink-testing-library skips
		// the mount, so `onFlush` is `undefined` and the path is purely
		// "write the Ref, then quit". 100ms is plenty for the
		// Effect.runFork to drain.
		const engine = await buildEngine();
		const onQuit = vi.fn();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('q');
		await flush(100);
		expect(onQuit).toHaveBeenCalledTimes(1);
		unmount();
	});

	it('q keypress flips engine.buildStatus to shutting-down', async () => {
		// The q-handler writes into the engine Ref synchronously (before its
		// 150ms render-window sleep). We don't assert on `lastFrame` here
		// because `inkApp.exit()` fires AFTER the sleep — by then ink has
		// stopped rendering and the test writer's buffer is empty. The Ref
		// state is what drives the rendered header tint while ink is still
		// alive; that's covered by the dedicated "header" test below.
		const engine = await buildEngine();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('q');
		// Status write is synchronous inside the Effect.runFork; a single
		// microtask flush is enough to observe it.
		await flush(50);
		const state = await Effect.runPromise(Ref.get(engine.tuiState));
		expect(state.header.buildStatus).toBe('shutting-down');
		unmount();
	});

	it('shutting-down build status renders [shutting-down] in the header', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.setHeader({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				cycle: 2,
				buildStatus: 'shutting-down',
			}),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		expect(lastFrame() ?? '').toContain('[shutting-down]');
		unmount();
	});

	it('q keypress appends a teardown-narration log line', async () => {
		const engine = await buildEngine();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('q');
		await flush(200);
		const state = await Effect.runPromise(Ref.get(engine.tuiState));
		const tail = state.logs[state.logs.length - 1];
		expect(tail).toBeDefined();
		// Phase 4 shutdown copy: "Shutting down. Sui and other background
		// services stay warm for a fast next start. Run `pnpm exec devstack
		// wipe --yes` to clear all local state." Three assertions: it's a
		// real teardown narration, it mentions services staying warm so the
		// user knows they aren't losing state, and it points at `devstack
		// wipe` for the full nuke. Must NOT contain "container" — the v3
		// docker-leaky vocabulary disappears from user-facing copy.
		expect(tail?.message).toContain('Shutting down');
		expect(tail?.message).toContain('stay warm');
		expect(tail?.message).toContain('devstack wipe');
		expect(tail?.message).not.toContain('container');
		unmount();
	});

	it('R (capital) keypress triggers engine.requestRestart (full restart)', async () => {
		const engine = await buildEngine();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('R');
		// The keypress offers into the engine's restart queue; the test
		// observes the wake via `awaitRestart` with a short timeout.
		await Effect.runPromise(Effect.timeout(engine.awaitRestart, '500 millis'));
		unmount();
	});

	it('r (lowercase) keypress triggers engine.requestRestart (full restart)', async () => {
		// After the per-primitive scope rollback, both `r` and `R` trigger
		// a full stack restart via requestRestart. True per-primitive retry
		// would need a per-primitive scope architecture.
		const engine = await buildEngine();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('r');
		await Effect.runPromise(Effect.timeout(engine.awaitRestart, '500 millis'));
		unmount();
	});

	it('logs appended to engine.tuiState surface in the rendered frame', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.appendLog({ ts: Date.now(), level: 'info', message: 'sui localnet ready' }),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('sui localnet ready');
		expect(frame).toContain('info');
		unmount();
	});

	it('rows group by the leading `<group>.<name>` segment of the title', async () => {
		// `sui.localnet`, `accounts.alice`, `publish.hello` all share the
		// `<group>.<name>` shape, so the table renders three section
		// headers (`Sui`, `Accounts`, `Publish`) with the bare `<name>`
		// inside each row — no redundant `<group>.` prefix on the row
		// itself.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([
				{ key: 'sui.localnet', kind: 'service', title: 'sui.localnet' },
				{ key: 'accounts.alice', kind: 'action', title: 'accounts.alice' },
				{ key: 'publish.hello', kind: 'action', title: 'publish.hello' },
			]),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Services');
		expect(frame).toContain('Actions');
		expect(frame).toContain('Actions');
		// Bare `<name>` inside the section — no `<group>.<name>` duplication.
		expect(frame).toContain('localnet');
		expect(frame).toContain('alice');
		expect(frame).toContain('hello');
		unmount();
	});

	it('seeded title surfaces while still pending (no markAcquiring yet)', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: '@devstack/Sui', kind: 'service', title: 'sui.localnet' }]),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		// The new grouped layout renders `Sui` as the section header and
		// `localnet` as the row name — so the original `sui.localnet`
		// title shows up split across two lines rather than verbatim.
		expect(frame).toContain('Services');
		expect(frame).toContain('localnet');
		expect(frame).not.toContain('@devstack/Sui');
		expect(frame).toContain('pending');
		unmount();
	});

	it('long error truncates instead of wrapping onto a second row', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: '@devstack/Sui', kind: 'service' }]));
		const { Cause } = await import('effect');
		// Docker-style multi-paragraph stderr that would wrap badly without
		// truncation. We assert (a) the row contains the prefix, (b) the
		// row does NOT contain the tail (proving the cap fired), and
		// (c) every newline-separated piece of the rendered frame lands
		// on one row per entry (no internal wrap from the detail cell).
		const longError =
			'failed to create sui docker network ' +
			"'dvst.arena.main.sui.network': docker network create — exit 1 — stderr: " +
			'Error response from daemon: invalid pool request: Pool overlaps with ' +
			'other one on this address space. ' +
			'The full text is sufficiently long to demand truncation across both layers.';
		await Effect.runPromise(engine.markFailed('@devstack/Sui', Cause.fail(new Error(longError))));
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('failed');
		expect(frame).toContain('failed to create sui docker');
		expect(frame).not.toContain('demand truncation');
		// Truncation marker (`…`) lands inside the row's detail column when
		// the char-cap fires. Confirms the cap is the source of truth.
		expect(frame).toContain('…');
		unmount();
	});

	it('acquiring entry surfaces the active phase as the status word', async () => {
		// Phase narration is promoted to the status column: instead of a
		// generic 'acquiring' badge alongside a `(running genesis)` detail,
		// the row reads `⊙ localnet  running` — the user reads WHAT a
		// multi-step primitive is doing without a redundant detail cell.
		// The first word of the phase ('running genesis' → 'running') is
		// the default; `PHASE_STATUS_OVERRIDES` rewrites the longer phrases.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: 'sui.localnet', kind: 'service', title: 'sui.localnet' }]),
		);
		await Effect.runPromise(engine.markAcquiring('sui.localnet', 'service'));
		await Effect.runPromise(engine.setPhase('sui.localnet', 'running genesis'));

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('running');
		expect(normalized).not.toContain('acquiring');
		unmount();
	});

	it('acquiring entry without a phase falls back to the "starting" status word', async () => {
		// `acquiring` reads as if something is being downloaded; "starting"
		// is the right generic verb when no specific phase is set.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: 'sui.localnet', kind: 'service', title: 'sui.localnet' }]),
		);
		await Effect.runPromise(engine.markAcquiring('sui.localnet', 'service'));

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('starting');
		expect(normalized).not.toContain('acquiring');
		unmount();
	});

	it('phase override maps the awaiting-rpc compound phase to "waiting"', async () => {
		// The compound phase 'awaiting rpc + faucet + graphql' would surface
		// as 'awaiting' on the default first-word path; the explicit override
		// rewrites it to 'waiting' for parity with other override entries
		// ('awaiting ready' → 'waiting', 'requesting funds' → 'funding').
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: 'sui.localnet', kind: 'service', title: 'sui.localnet' }]),
		);
		await Effect.runPromise(engine.markAcquiring('sui.localnet', 'service'));
		await Effect.runPromise(engine.setPhase('sui.localnet', 'awaiting rpc + faucet + graphql'));

		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		const normalized = frame.replace(/\s+/g, ' ');
		expect(normalized).toContain('waiting');
		unmount();
	});

	it('unclassified entry lands under the synthetic `Other` section', async () => {
		// Keys without a `<group>.<name>` shape (`wallet`, `manifest`,
		// `dev-server`) land under the synthetic `Other` header so they
		// have a place to sit alongside the prefixed groups.
		const engine = await buildEngine();
		await Effect.runPromise(
			Ref.update(engine.tuiState, (s) => ({
				...s,
				entries: [{ key: 'mystery', kind: 'other' as const, status: 'ready' as const }],
			})),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('mystery');
		expect(frame).toContain('Other');
		unmount();
	});

	it('multi-endpoint entry renders each endpoint on its own indented line', async () => {
		// Sui localnet exposes RPC + faucet + GraphQL; surfacing only one
		// URL in `primary` hid the other two. The `endpoints` payload puts
		// each on its own line below the row so users can read + copy
		// each independently.
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: '@devstack/Sui', kind: 'service', title: 'sui.localnet' }]),
		);
		await Effect.runPromise(engine.markAcquiring('@devstack/Sui', 'service'));
		await Effect.runPromise(
			engine.markReady('@devstack/Sui', {
				title: 'sui.localnet',
				endpoints: [
					{ label: 'rpc', url: 'http://localhost:9000' },
					{ label: 'faucet', url: 'http://localhost:9123' },
					{ label: 'graphql', url: 'http://localhost:9125/graphql' },
				],
			}),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('rpc');
		expect(frame).toContain('http://localhost:9000');
		expect(frame).toContain('faucet');
		expect(frame).toContain('http://localhost:9123');
		expect(frame).toContain('graphql');
		expect(frame).toContain('http://localhost:9125/graphql');
		unmount();
	});

	it('renders full packageId / address without truncating to `0x…`', async () => {
		// Pre-fix, `display` collapsed packageIds + addresses to `0xabc…123`
		// for layout reasons. That broke the copy-paste workflow (paste a
		// packageId into a Move script, into an explorer). New layout
		// renders the full 64-char hex; ink's `wrap='wrap'` flows overflow
		// onto a second line if the terminal is narrow.
		const engine = await buildEngine();
		const fullId = '0x' + 'a1b2c3d4e5f6'.repeat(5).slice(0, 64);
		await Effect.runPromise(
			engine.seedTags([{ key: 'publish.demo', kind: 'action', title: 'publish.demo' }]),
		);
		await Effect.runPromise(engine.markAcquiring('publish.demo', 'action'));
		await Effect.runPromise(
			engine.markReady('publish.demo', { title: 'publish.demo', primary: fullId }),
		);
		const { lastFrame, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		const frame = lastFrame() ?? '';
		// Strip whitespace introduced by ink's wrap so we can find the id
		// even when it spans a line break.
		const normalized = frame.replace(/\s+/g, '');
		expect(normalized).toContain(fullId);
		unmount();
	});

	// Phase 5 — selective-restart visual cue. The plan calls for the dim-
	// animation hook to light up the affected rows so the user can visually
	// trace a watch-fire cascade. We assert two invariants:
	//   - `markSelectiveRestart({k})` flips ONLY k's row into the "affected"
	//     visual state — siblings stay calm.
	//   - `markReady(k)` clears the flag, so the cue dies once the row
	//     finishes re-acquiring (no stale highlight).
	// The full data-binding (real dep graph → affected set) lands in P2;
	// this test pins the surface so P2 can't accidentally break it.
	it('selective-restart: flag flips on markSelectiveRestart and clears on markReady', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([
				{ key: '@devstack/Sui', kind: 'service' },
				{ key: 'publish.vault', kind: 'action' },
				{ key: 'codegen', kind: 'action' },
			]),
		);
		// Seed all three rows into a `ready` baseline, then fire a watch-
		// driven invalidation on publish.vault + codegen.
		for (const k of ['@devstack/Sui', 'publish.vault', 'codegen']) {
			await Effect.runPromise(engine.markAcquiring(k));
			await Effect.runPromise(engine.markReady(k, { title: k }));
		}
		await Effect.runPromise(
			engine.markSelectiveRestart(new Set(['publish.vault', 'codegen'])),
		);
		// Move the affected rows to `acquiring`; Sui should NOT be touched
		// because it's outside the affected set.
		await Effect.runPromise(engine.markAcquiring('publish.vault'));
		await Effect.runPromise(engine.markAcquiring('codegen'));

		// Snapshot directly off the engine ref — the visual cue is a
		// rendering of `selectiveRestart`, but the engine state is the
		// source of truth and is what P2 will read.
		const stateAfterFire = await Effect.runPromise(Ref.get(engine.tuiState));
		const vaultEntry = stateAfterFire.entries.find((e) => e.key === 'publish.vault');
		const codegenEntry = stateAfterFire.entries.find((e) => e.key === 'codegen');
		const suiEntry = stateAfterFire.entries.find((e) => e.key === '@devstack/Sui');
		expect(vaultEntry?.selectiveRestart).toBe(true);
		expect(codegenEntry?.selectiveRestart).toBe(true);
		expect(suiEntry?.selectiveRestart).toBeUndefined();
		// Sui's row should still be `ready` — no flicker.
		expect(suiEntry?.status).toBe('ready');

		// Drive the affected rows through to `ready` again and confirm the
		// flag clears so the next watch-fire starts from a clean slate.
		await Effect.runPromise(engine.markReady('publish.vault', { title: 'publish.vault' }));
		await Effect.runPromise(engine.markReady('codegen', { title: 'codegen' }));
		const stateAfterReady = await Effect.runPromise(Ref.get(engine.tuiState));
		for (const k of ['publish.vault', 'codegen']) {
			const e = stateAfterReady.entries.find((x) => x.key === k);
			expect(e?.status).toBe('ready');
			expect(e?.selectiveRestart).toBeUndefined();
		}
	});

	it('selective-restart: unknown keys are silently dropped (no ghost row)', async () => {
		// The dep graph may carry a key the engine didn't seed (out-of-date
		// graph, stack reshuffle between cycles). markSelectiveRestart
		// should NOT auto-register a fresh row for that key — the UX hint
		// fails closed, not noisy.
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: 'publish.vault', kind: 'action' }]));
		await Effect.runPromise(
			engine.markSelectiveRestart(new Set(['publish.vault', 'ghost.key'])),
		);
		const state = await Effect.runPromise(Ref.get(engine.tuiState));
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]?.key).toBe('publish.vault');
		expect(state.entries[0]?.selectiveRestart).toBe(true);
	});

	it('selective-restart: re-acquire reflows the row through acquiring → ready', async () => {
		// P5.T2: confirm `markAcquiring` → `markReady` row transitions still
		// fire correctly on a selective re-acquire path (the same path P3's
		// invalidateSubset will drive through tag.ts's withEngineLifecycle).
		// Pre-Phase-2 we can't exercise the real Layer re-build, but the
		// row-state mechanism is identical, so this pins the engine-side
		// invariant the rendering layer counts on.
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: 'publish.vault', kind: 'action' }]));
		await Effect.runPromise(engine.markAcquiring('publish.vault'));
		await Effect.runPromise(engine.markReady('publish.vault', { title: 'publish.vault' }));

		// Simulate a selective re-acquire.
		await Effect.runPromise(engine.markSelectiveRestart(new Set(['publish.vault'])));
		await Effect.runPromise(engine.markAcquiring('publish.vault'));
		const mid = await Effect.runPromise(Ref.get(engine.tuiState));
		const midEntry = mid.entries.find((e) => e.key === 'publish.vault');
		expect(midEntry?.status).toBe('acquiring');
		expect(midEntry?.selectiveRestart).toBe(true);

		await Effect.runPromise(engine.markReady('publish.vault', { title: 'publish.vault' }));
		const after = await Effect.runPromise(Ref.get(engine.tuiState));
		const afterEntry = after.entries.find((e) => e.key === 'publish.vault');
		expect(afterEntry?.status).toBe('ready');
		expect(afterEntry?.selectiveRestart).toBeUndefined();
	});
});
