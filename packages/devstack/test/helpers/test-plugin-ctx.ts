// Test-only PluginCtx harness — drive a converted plugin's `start(deps)`
// with a decl-CAPTURING fake ctx and assert on the captured
// contributions.
//
// Stage B converts plugins from a `capabilities: ({value,runtime}) =>
// CapabilityDecl[]` second-closure to emitting contributions INLINE in
// `start(deps)` via the typed `ctx.*` verbs (`const ctx = yield*
// PluginContext`; see `src/substrate/plugin-ctx.ts`). Tests that
// previously drove the `capabilities` closure as a pure function (and
// inspected the returned decls) must instead drive `start(deps)` with
// THIS harness — PROVIDING the captured ctx as the `PluginContext`
// service via `harness.provide(...)` (mirroring the supervisor's
// `Effect.provideService(start(deps), PluginContext, ctx)`) — and assert
// the `captured.*` arrays.
//
// Shape parity: the four buffered verbs + `provides` capture into the
// matching `captured.*` array in CALL ORDER — exactly the order the
// supervisor's real `makePluginCtx` (acquire-node.ts) pushes them into
// its replay buffer, so a test asserting `captured.codegen[0]` sees what
// the orchestrator would dispatch. `persist` is the same thin
// ArtifactPublisher pass-through the supervisor builds (forwards the
// plugin-supplied hex `spec.chain` verbatim); the default behaviour
// mirrors the `cacheMissPublisher` stub used across the plugin tests
// (run `produce`, `register(produced)`, return produced). `requires`
// resolves from an injected strategy map or fails with
// `StrategyNotFoundError`; `fail` is `Effect.fail`.

import { Effect, type Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
	ArtifactSpec,
} from '../../src/primitives/artifact-publisher.ts';
import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import type { ProjectionDecl } from '../../src/contracts/projection.ts';
import type { RoutableDecl } from '../../src/contracts/routable.ts';
import type { SnapshotableDecl } from '../../src/contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../src/contracts/strategy-contributor.ts';
import type { PluginCtx } from '../../src/substrate/plugin-ctx.ts';
import { PluginContext } from '../../src/substrate/plugin-ctx.ts';
import { StrategyNotFoundError } from '../../src/substrate/runtime/errors.ts';

/** The decls captured per buffered verb (+ `provides`), each in call
 *  order. Mirrors the supervisor's replay-buffer ordering. */
export interface CapturedDecls {
	readonly codegen: CodegenableDecl[];
	readonly endpoint: RoutableDecl[];
	readonly snapshotExtra: SnapshotableDecl[];
	readonly publish: ProjectionDecl[];
	readonly provides: StrategyContributorDecl[];
}

/** Configuration for the fake ctx. Everything is optional — the
 *  zero-arg form gives a usable cache-miss `persist`, an empty strategy
 *  registry, and capturing verbs. */
export interface TestPluginCtxOptions {
	/** Override `persist` wholesale with a custom ArtifactPublisher.
	 *  When set, `persisted` still records every spec, but the supplied
	 *  publisher decides verify/produce/register/return semantics. Use
	 *  the existing `cacheHitPublisher` / `cacheMissPublisher` stubs from
	 *  the plugin tests here. */
	readonly publisher?: ArtifactPublisher;
	/** Strategies a `ctx.requires(key)` read resolves to, by capability
	 *  key. A key absent from the map fails with `StrategyNotFoundError`
	 *  listing the provided keys (matching the real registry's error
	 *  shape). */
	readonly strategies?: Readonly<Record<string, unknown>>;
}

/** What `makeTestPluginCtx` hands back: the captured `ctx`, a `provide`
 *  helper that satisfies a plugin start's `PluginContext` requirement
 *  with that ctx, the per-verb `captured` arrays, and the ordered list of
 *  `persisted` specs (for `persist` assertions). */
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
	/** Every `ArtifactSpec` passed to `ctx.persist`, in call order. The
	 *  generics are erased to `unknown` at capture (the harness is
	 *  payload-blind); narrow at the assertion site. */
	readonly persisted: Array<ArtifactSpec<unknown, unknown>>;
}

/** Default `persist` behaviour: cache-MISS path — run `produce`,
 *  `register(produced)`, return produced. Mirrors the `cacheMissPublisher`
 *  stub recurring across the plugin tests, so a converted plugin's
 *  `ctx.persist(spec)` exercises its `produce`/`register` bodies. */
const defaultPublisher: ArtifactPublisher = {
	publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
		Effect.gen(function* () {
			const produced = yield* spec.produce;
			yield* spec.register(produced);
			return produced;
		}),
};

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
export const makeTestPluginCtx = (opts: TestPluginCtxOptions = {}): TestPluginCtxHarness => {
	const captured: CapturedDecls = {
		codegen: [],
		endpoint: [],
		snapshotExtra: [],
		publish: [],
		provides: [],
	};
	const persisted: Array<ArtifactSpec<unknown, unknown>> = [];
	const publisher = opts.publisher ?? defaultPublisher;
	const strategies = opts.strategies ?? {};

	const ctx: PluginCtx = {
		persist: (spec) => {
			persisted.push(spec as ArtifactSpec<unknown, unknown>);
			return publisher.publish(spec);
		},
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
		requires: <K extends string>(key: K) =>
			key in strategies
				? Effect.succeed(strategies[key] as never)
				: Effect.fail(
						new StrategyNotFoundError({
							capabilityKey: key,
							registeredKeys: Object.keys(strategies),
						}),
					),
		fail: (error) => Effect.fail(error) as Effect.Effect<never>,
	};

	const provide = <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E, Exclude<R, PluginContext>> =>
		Effect.provideService(effect, PluginContext, ctx);

	return { ctx, provide, captured, persisted };
};
