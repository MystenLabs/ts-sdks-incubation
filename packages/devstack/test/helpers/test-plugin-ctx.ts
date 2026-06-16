// Test-only PluginCtx harness — drive a converted plugin's `start(deps)`
// with a decl-CAPTURING fake ctx and assert on the captured
// contributions.
//
// Plugins emit contributions INLINE in `start(deps)` via the typed
// `ctx.*` verbs (`const ctx = yield* PluginContext`; see
// `src/substrate/plugin-ctx.ts`). Tests drive `start(deps)` with
// THIS harness — PROVIDING the captured ctx as the `PluginContext`
// service via `harness.provide(...)` (mirroring the supervisor's
// `Effect.provideService(start(deps), PluginContext, ctx)`) — and assert
// the `captured.*` arrays.
//
// Shape parity: the four buffered verbs + `provides` capture into the
// matching `captured.*` array in CALL ORDER — exactly the order the
// supervisor's real `makePluginCtx` (acquire-node.ts) pushes them into
// its replay buffer, so a test asserting `captured.codegen[0]` sees what
// the orchestrator would dispatch.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import type { ProjectionDecl } from '../../src/contracts/projection.ts';
import type { RoutableDecl } from '../../src/contracts/routable.ts';
import type { SnapshotableDecl } from '../../src/contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../src/contracts/strategy-contributor.ts';
import type { PluginCtx } from '../../src/substrate/plugin-ctx.ts';
import { PluginContext } from '../../src/substrate/plugin-ctx.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import { IdentityContext } from '../../src/substrate/runtime/paths.ts';

/** The decls captured per buffered verb (+ `provides`), each in call
 *  order. Mirrors the supervisor's replay-buffer ordering. */
export interface CapturedDecls {
	readonly codegen: CodegenableDecl[];
	readonly endpoint: RoutableDecl[];
	readonly snapshotExtra: SnapshotableDecl[];
	readonly publish: ProjectionDecl[];
	readonly provides: StrategyContributorDecl[];
}

/** What `makeTestPluginCtx` hands back: the captured `ctx`, a `provide`
 *  helper that satisfies a plugin start's `PluginContext` requirement
 *  with that ctx, and the per-verb `captured` arrays. */
export interface TestPluginCtxHarness {
	readonly ctx: PluginCtx;
	/** Provide the captured ctx as the `PluginContext` service into a
	 *  plugin `start` effect's requirement channel — mirrors the
	 *  supervisor's `Effect.provideService(start(deps), PluginContext,
	 *  ctx)`. Pass `member.start(deps)` here; the remaining R-channel
	 *  (infra services the plugin `yield*`s) is the test's to provide. */
	readonly provide: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, Exclude<R, PluginContext>>;
	readonly captured: CapturedDecls;
}

/**
 * Build a decl-capturing fake `PluginCtx` for driving a converted
 * plugin's `start(deps)` under `it.effect`-style tests. The plugin
 * reaches its ctx with `yield* PluginContext`, so the start effect must
 * be run with the captured ctx provided — use the harness `provide`
 * helper (mirrors the supervisor's `Effect.provideService`).
 *
 * Usage:
 *
 * ```ts
 * it.effect('contributes the WAL funding strategy', () =>
 *   Effect.gen(function* () {
 *     const { provide, captured } = makeTestPluginCtx();
 *     yield* provide(member.start(deps));
 *     const wal = captured.provides.find(
 *       (d) => d.capabilityKey === walFaucetStrategyKey('0x…::wal::WAL'),
 *     );
 *     expect(wal).toBeDefined();
 *   }),
 * );
 * ```
 */
export const makeTestPluginCtx = (
	/** When set, `provide` also supplies `IdentityContext` — for plugins that
	 *  read `identity.network` (deepbook, walrus, …). Omit for plugins that
	 *  provide their own identity downstream (e.g. host-service). */
	opts?: { readonly identity?: Identity },
): TestPluginCtxHarness => {
	const captured: CapturedDecls = {
		codegen: [],
		endpoint: [],
		snapshotExtra: [],
		publish: [],
		provides: [],
	};

	const ctx: PluginCtx = {
		codegen: <E extends string>(decl: CodegenableDecl<E>): void => {
			captured.codegen.push(decl);
		},
		endpoint: (decl: RoutableDecl): void => {
			captured.endpoint.push(decl);
		},
		snapshotExtra: (decl: SnapshotableDecl): void => {
			captured.snapshotExtra.push(decl);
		},
		publish: (decl: ProjectionDecl): void => {
			captured.publish.push(decl);
		},
		provides: <K extends string, S>(decl: StrategyContributorDecl<K, S>): void => {
			captured.provides.push(decl as StrategyContributorDecl);
		},
	};

	const provide = <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E, Exclude<R, PluginContext>> => {
		const withPlugin = Effect.provideService(effect, PluginContext, ctx);
		return (
			opts?.identity
				? Effect.provideService(withPlugin, IdentityContext, opts.identity)
				: withPlugin
		) as Effect.Effect<A, E, Exclude<R, PluginContext>>;
	};

	return { ctx, provide, captured };
};
