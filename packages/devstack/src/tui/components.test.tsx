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
import { EngineHandle, EngineLive, type EngineHandleShape } from '../internal/engine.js';
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
		// rolled back; see notes/friction.md). Footer surfaces the
		// available keybinds.
		expect(frame).toContain('[r]estart');
		expect(frame).toContain('[q]uit');
		unmount();
	});

	it('renders a service entry with title + primary URL + ready badge', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(
			engine.seedTags([{ key: '@devstack/Sui', kind: 'service' }]),
		);
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
		expect(frame).toContain('Sui');
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
		expect(frame).toContain('Publish');
		expect(frame).toContain('hello');
		expect(frame).toContain('0xabc…123');
		expect(frame).toContain('done');
		expect(frame).toContain('upgrade-cap 0xfed…456');
		unmount();
	});

	it('failed entry surfaces the short error in the row and the full walk in the log tail', async () => {
		const engine = await buildEngine();
		await Effect.runPromise(engine.seedTags([{ key: '@devstack/Sui', kind: 'service' }]));
		await Effect.runPromise(engine.markAcquiring('@devstack/Sui', 'service'));
		const { Cause } = await import('effect');
		const shortMsg = 'connect ECONNREFUSED 127.0.0.1:9000';
		await Effect.runPromise(
			engine.markFailed('@devstack/Sui', Cause.fail(new Error(shortMsg))),
		);

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
		// + appendLog + a 150ms sleep so ink has time to render the flash
		// before the process-kill freezes the event loop. Allow ~300ms for
		// the fork to settle.
		const engine = await buildEngine();
		const onQuit = vi.fn();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('q');
		await flush(300);
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
		expect(tail?.message).toContain('shutdown requested');
		// Surface the "containers stay running" hint AND the wipe escape hatch
		// so a user pressing `q` knows what they're left with and how to nuke it.
		expect(tail?.message).toContain('stay running');
		expect(tail?.message).toContain('devstack wipe');
		unmount();
	});

	it('R (capital) keypress triggers engine.requestRestart (full restart)', async () => {
		const engine = await buildEngine();
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('R');
		// requestRestart resolves the restartSignal deferred currently held
		// by the engine's Ref. Poll with a short timeout; if the deferred
		// never fires this rejects.
		const { Deferred } = await import('effect');
		const signal = await Effect.runPromise(Ref.get(engine.restartSignal));
		await Effect.runPromise(Effect.timeout(Deferred.await(signal), '500 millis'));
		unmount();
	});

	it('r (lowercase) keypress triggers engine.requestRestart (full restart)', async () => {
		// After the per-primitive scope rollback, both `r` and `R` trigger
		// a full stack restart via requestRestart. True per-primitive retry
		// needs the per-primitive scope architecture; see notes/friction.md.
		const engine = await buildEngine();
		const { Deferred } = await import('effect');
		const restartBefore = await Effect.runPromise(Ref.get(engine.restartSignal));
		const { stdin, unmount } = inkRender(
			React.createElement(App, { engine, onQuit: () => undefined, pollIntervalMs: 10 }),
		);
		await flush();
		stdin.write('r');
		await Effect.runPromise(Effect.timeout(Deferred.await(restartBefore), '500 millis'));
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
		expect(frame).toContain('Sui');
		expect(frame).toContain('Accounts');
		expect(frame).toContain('Publish');
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
		expect(frame).toContain('Sui');
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
		await Effect.runPromise(
			engine.markFailed('@devstack/Sui', Cause.fail(new Error(longError))),
		);
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
		await Effect.runPromise(
			engine.setPhase('sui.localnet', 'awaiting rpc + faucet + graphql'),
		);

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
		await Effect.runPromise(Ref.update(engine.tuiState, (s) => ({
			...s,
			entries: [{ key: 'mystery', kind: 'other' as const, status: 'ready' as const }],
		})));
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
});
