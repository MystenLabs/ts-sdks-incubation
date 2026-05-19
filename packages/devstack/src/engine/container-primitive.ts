// `containerPrimitive(spec)` — substrate for race-safe long-running
// container management.
//
// Subsumes the `inspect → adopt/start/recreate/run` pattern every
// long-running container primitive reimplements (walrus storage nodes,
// seal key-server, deepbook indexer/server, sui-build-container) AND
// serialises that pattern through a per-container-name `Semaphore` so
// two concurrent `apply` cycles or vitest workers can't TOCTOU on the
// `docker rm` / `docker run` window.
//
// Internally we DO NOT rewrite the `Docker.run` body — that helper
// already handles adopt-if-image-matches, resume, recreate-on-image-
// mismatch, traefik label materialization, scope-bound finalizers.
// `containerPrimitive` adds (1) the per-name serialisation and (2) the
// `LayeredTag` wiring on top, with the same `upstream`-as-typed-record
// pattern as `onChainArtifact`.

import { Effect, Semaphore } from 'effect';
import type { DockerError } from './errors.js';
import type { ReadyProbeError } from './ready-probe.js';
import { tag, type LayeredTag, type TagKind, type TuiDisplay } from '../advanced/tag.js';
import {
	runDockerContainer,
	type DockerContainerImageInternal,
	type DockerContainerOptions,
	type DockerContainerHandle,
} from '../advanced/plugin-author/docker-container.js';
import type { Resolved, UpstreamE } from './on-chain-artifact.js';

// -----------------------------------------------------------------------------
// Per-container-name lock registry
// -----------------------------------------------------------------------------

// Module-scoped `name → Semaphore(1)` map. Two concurrent
// `containerPrimitive` invocations with the same `spec.name` serialise
// through the same semaphore; primitives with different names don't
// block each other.
//
// The map is module-level (NOT per-Layer) so concurrent vitest workers
// using the same JS process see the same mutex set. Cross-process
// races (two `pnpm dev` instances) are still possible — those go
// through docker's own atomicity on `--name` collisions, which is the
// boundary the `Docker.run` body already handles.
const ensureLocks = new Map<string, Semaphore.Semaphore>();

const lockFor = (name: string): Semaphore.Semaphore => {
	let lock = ensureLocks.get(name);
	if (lock === undefined) {
		lock = Semaphore.makeUnsafe(1);
		ensureLocks.set(name, lock);
	}
	return lock;
};

/**
 * Internal helper: drop the lock for `name`. Exported so tests can
 * isolate per-test state without leaking semaphores across runs (in
 * production the lock lives until process exit, which is fine —
 * semaphores are tiny and the set is bounded by primitive count).
 */
export const _resetContainerLocksForTest = (): void => {
	ensureLocks.clear();
};

// -----------------------------------------------------------------------------
// Spec contract
// -----------------------------------------------------------------------------

/**
 * Spec passed to `containerPrimitive`. The `upstream` record is the
 * single source of truth for this primitive's dependencies (same shape
 * as `OnChainArtifactSpec.upstream`). `run` / `image` are the
 * pass-through `dockerContainer` options; `runOptions` (when present)
 * is a function that receives the resolved upstream bundle and returns
 * the run options — use this when run-time config depends on a sibling
 * tag's resolved shape (e.g. mounting a seal key-server with a
 * container-IP derived from a sibling network primitive's resolved
 * subnet allocation).
 */
export interface ContainerPrimitiveSpec<
	Name extends string,
	U extends Record<string, LayeredTag<any, any, any, any> | undefined>,
	Handle = DockerContainerHandle,
> {
	// ── Tag identity ──
	readonly name: Name;
	readonly plugin: string;
	readonly kind?: TagKind;
	readonly displayTitle?: string;
	readonly display?: (handle: Handle) => TuiDisplay;
	readonly hidden?: boolean;

	// ── Upstream record (single source of truth for deps) ──
	readonly upstream: U;

	// ── Image / run options ──
	/** Image source — `{pull}`, `{build}`, or (internal) `{tag}` form
	 *  matching `DockerContainerImage` / `DockerContainerImageInternal`.
	 *  Must resolve at FACTORY time (image-build layer runs before the
	 *  container tag), so this slot does NOT accept the deps-aware
	 *  function form — pre-resolve via a sibling tag if a dep is
	 *  needed. */
	readonly image: DockerContainerImageInternal;
	/** Static or deps-aware run options (env, mounts, ports, networking,
	 *  routing, ready probe). When a function is passed, it receives the
	 *  resolved upstream bundle so deps can flow into the container
	 *  config (e.g. environment variables computed from sibling tags). */
	readonly run:
		| Omit<DockerContainerOptions, 'image'>
		| ((deps: Resolved<U>) => Omit<DockerContainerOptions, 'image'>);

	// ── Handle projection ──
	/**
	 * Project the underlying `DockerContainerHandle` (URLs, ports,
	 * container id) into the user-facing `Handle` shape, optionally
	 * consuming resolved upstreams. Defaults to an identity projection.
	 */
	readonly handle?: (args: {
		readonly raw: DockerContainerHandle;
		readonly deps: Resolved<U>;
	}) => Handle;

	// ── Watch patterns (forwarded to the tag) ──
	readonly watch?: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// containerPrimitive
// -----------------------------------------------------------------------------

/**
 * Long-running container primitive. Race-safe (per-name `Semaphore(1)`)
 * around the underlying `Docker.run` flow, projected through the
 * caller's `handle` mapper, and surfaced as a `LayeredTag<Name, Handle>`.
 *
 * Why this exists: every site that hand-rolls a `Docker.run` ALSO
 * hand-rolls the `inspect → adopt/start/recreate/run` race-window
 * (B6, B12 in the redesign doc). `Docker.run` already collapses the
 * action-decision pure logic (`decideRunAction` in
 * `engine/docker/core.ts`) into one call — what's left is the
 * "two concurrent `apply` cycles don't both hit the rm/run window"
 * serialisation, which is exactly a `Semaphore(1)` keyed on the
 * resolved container name.
 *
 */
export const containerPrimitive = <
	const Name extends string,
	U extends Record<string, LayeredTag<any, any, any, any> | undefined>,
	Handle = DockerContainerHandle,
>(
	spec: ContainerPrimitiveSpec<Name, U, Handle>,
): LayeredTag<Name, Handle, never, DockerError | ReadyProbeError | UpstreamE<U>> => {
	// Resolve the upstream bundle once at acquire time. Yielded tag
	// identities flow through R; `tag()`'s `Layer.effect` ties them off.
	const resolveUpstream = Effect.gen(function* () {
		const out: Record<string, unknown> = {};
		for (const [alias, dep] of Object.entries(spec.upstream)) {
			if (dep === undefined) {
				out[alias] = undefined;
				continue;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			out[alias] = yield* dep as unknown as Effect.Effect<unknown, any, any>;
		}
		return out as Resolved<U>;
	});

	// `run` resolution can't depend on deps when it's a static object;
	// when it's a function we MUST defer until we have the deps. The
	// image, on the other hand, ALWAYS resolves at factory time — image
	// builds wrap the container layer. Static run options give us the
	// runDockerContainer call up front (so its imageLayers are surfaced
	// via `extraLayers`); deps-aware run options force a lazier path
	// where the container layer is constructed inside the build body.
	const runIsStatic = typeof spec.run !== 'function';
	const staticRunOpts = runIsStatic ? (spec.run as Omit<DockerContainerOptions, 'image'>) : null;

	// For the static-run case we can pre-call runDockerContainer here so
	// `imageLayers` lands in the tag's `__layers` via `extraLayers`.
	const staticContainer =
		staticRunOpts !== null
			? runDockerContainer(spec.name, { ...staticRunOpts, image: spec.image })
			: null;

	const build = Effect.gen(function* () {
		const deps = yield* resolveUpstream;
		const lock = lockFor(spec.name);

		const runOpts: Omit<DockerContainerOptions, 'image'> =
			staticRunOpts !== null
				? staticRunOpts
				: (spec.run as (deps: Resolved<U>) => Omit<DockerContainerOptions, 'image'>)(deps);

		// In the static-run case, reuse the pre-computed runEffect to
		// keep the imageLayers wiring consistent. In the deps-aware case,
		// build a fresh container effect (its imageLayers stay attached
		// inside the body — out-of-tree consumers using deps-aware run
		// don't get the parallel image build, but that's the documented
		// tradeoff).
		const containerEff =
			staticContainer !== null
				? staticContainer.effect
				: runDockerContainer(spec.name, { ...runOpts, image: spec.image }).effect;

		const raw = yield* lock.withPermits(1)(containerEff);
		return spec.handle !== undefined ? spec.handle({ raw, deps }) : (raw as unknown as Handle);
	}) as Effect.Effect<Handle, DockerError | ReadyProbeError | UpstreamE<U>>;

	// Auto-flatten the upstream record into `upstreamKeys:` AND surface
	// each upstream tag's `__layers` so the supervisor's layer graph
	// provides their identities at the same scope as this container's
	// own build. Without surfacing the inner layers, `yield* dep` inside
	// the build body would fail with "Service not found".
	const upstreamTags = Object.values(spec.upstream).filter(
		(d): d is LayeredTag<any, any, any, any> => d !== undefined,
	);
	const upstreamLayers = upstreamTags.flatMap((u) => u.__layers ?? []);
	const imageLayers = staticContainer !== null ? staticContainer.imageLayers : [];

	const tagOptions = {
		plugin: spec.plugin,
		upstreamKeys: upstreamTags,
		// Surface upstream tags' layers + the static-run case's image-
		// build sub-layers. Together these form the per-tag layer
		// contribution: the supervisor builds upstreams + image BEFORE
		// the container tag's body runs.
		extraLayers: [...upstreamLayers, ...imageLayers],
		...(spec.kind !== undefined ? { kind: spec.kind } : { kind: 'service' as TagKind }),
		...(spec.display !== undefined
			? { display: spec.display as (value: unknown) => TuiDisplay }
			: {}),
		...(spec.displayTitle !== undefined ? { displayTitle: spec.displayTitle } : {}),
		...(spec.hidden === true ? { hidden: true } : {}),
		...(spec.watch !== undefined ? { watch: spec.watch } : {}),
	};

	return tag(spec.name, build, tagOptions) as LayeredTag<
		Name,
		Handle,
		never,
		DockerError | ReadyProbeError | UpstreamE<U>
	>;
};
