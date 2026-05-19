// `ensureContainer` — single race-safe primitive for adopt / resume / recreate
// / fresh container lifecycle. Subsumes the two parallel state machines that
// `engine/docker/core.ts::Docker.run` and
// `engine/sui-build-container.ts::ensureContainer` previously re-implemented
// in lockstep (audit finding E1).
//
// Why a shared helper:
//
//   - One inspect parser, one `RunAction` decision, one TOCTOU recovery, one
//     name-collision recovery. Bug fixes (B6, sui-build C/H, the "missing
//     vs already-in-use" misclassification) live in exactly one place.
//
//   - Per-`name` `Semaphore(1)` serializes concurrent adopt-or-create calls
//     for the SAME name within one JS process. Cross-process races (two
//     `pnpm dev` instances against the same app) still rely on docker's
//     own `--name` atomicity, but the in-process collision class — two
//     vitest workers, two `containerPrimitive` invocations colliding on
//     the supervisor's outer scope, etc. — is closed here.
//
//   - Long-running primitives (sui-localnet, walrus storage nodes, sui-build
//     container) all go through this primitive, so the load-bearing
//     `expectedExitCodes: [137]` opt-out (the SIGKILL-on-cycle-teardown
//     escape hatch for sui's blocking SIGINT-only handler) keeps working
//     uniformly.
//
// Design — what callers DO and DON'T own:
//
//   - The helper owns: inspect → decide → start / rm / call `run` →
//     recover. Returns `{containerId, reused, resumed, inspected}`.
//
//   - The caller owns: the actual `docker run` argv (built inside the
//     `run` callback), plus all post-creation side effects — finalizer
//     registration, traefik attach, log follower, port readback. Keeping
//     these outside the helper lets `Docker.run` keep its rich
//     side-effect envelope (router YAMLs, stop-signal selection, engine
//     tag-key markers) while sui-build's lifecycle stays minimal
//     (`docker rm -f` finalizer at teardown).
//
//   - The `run` callback receives a `RunContext` telling it WHY a fresh
//     create is being requested (fresh / recreate-image-mismatch /
//     recreate-unclean / recreate-resume-failed). Docker.run uses this
//     to decide whether to auto-allocate host ports (only on
//     resume-fallback with port-conflict stderr); sui-build ignores it
//     entirely (the sleeper container has no ports). The helper passes
//     through the resume-failure stderr so callers can do their own
//     stderr-pattern analysis without re-running `docker start`.

import { Effect, Semaphore } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { DockerError } from '../errors.js';
import { runCapturing, summarize, truncate, type Spawner } from './core.js';

// -----------------------------------------------------------------------------
// Per-name lock registry
// -----------------------------------------------------------------------------

// Module-scoped `name → Semaphore(1)` map. Two concurrent `ensureContainer`
// calls against the same `spec.name` serialise; different names don't
// block each other. The map is module-level (NOT per-Layer) so concurrent
// vitest workers using the same JS process see the same mutex set. Cross-
// process races still rely on docker's own `--name` atomicity (exit 125
// with "already in use"), which the `run`-callback fallback below
// recovers from.
const ENSURE_LOCKS = new Map<string, Semaphore.Semaphore>();

const lockFor = (name: string): Semaphore.Semaphore => {
	let lock = ENSURE_LOCKS.get(name);
	if (lock === undefined) {
		lock = Semaphore.makeUnsafe(1);
		ENSURE_LOCKS.set(name, lock);
	}
	return lock;
};

/**
 * Internal helper: drop the lock map for tests so isolated test runs
 * don't share semaphores. In production the map lives until process exit
 * — semaphores are tiny and the set is bounded by container count.
 */
export const _resetEnsureLocksForTest = (): void => {
	ENSURE_LOCKS.clear();
};

// -----------------------------------------------------------------------------
// Inspect — shared parser
// -----------------------------------------------------------------------------

/**
 * Shape returned by `inspectContainerByName`. Mirrors what
 * `decideRunAction` consumes — kept here (not re-exported from core) so
 * the helper module is self-contained.
 */
export interface InspectResult {
	readonly running: boolean;
	readonly image: string;
	readonly containerId: string;
	/** Exit code from the container's previous run, when known. `137` ==
	 *  SIGKILL — usually because docker's `stop --time` grace expired
	 *  before the workload could clean up. */
	readonly lastExitCode?: number;
}

/**
 * `docker inspect --format` probe with the full
 * `Running|Image|Id|ExitCode` field set. Returns `null` if no container
 * by that name exists (docker exit 1, "No such object"). Errors during
 * inspect (daemon unreachable, etc.) also return `null` so the caller
 * can branch on existence with one check — matching the pre-E1
 * behavior of both callers.
 */
export const inspectContainerByName = (
	spawner: Spawner,
	name: string,
): Effect.Effect<InspectResult | null, never> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}|{{.Config.Image}}|{{.Id}}|{{.State.ExitCode}}',
			name,
		]);
		const captured = yield* runCapturing(spawner, cmd, 'docker inspect').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (captured === null || captured.exitCode !== 0) return null;
		const line = captured.stdout.trim();
		const parts = line.split('|');
		if (parts.length !== 4) return null;
		const [runningStr, image, containerId, exitCodeStr] = parts as [
			string,
			string,
			string,
			string,
		];
		if (image.length === 0 || containerId.length === 0) return null;
		const exitCodeParsed = Number.parseInt(exitCodeStr, 10);
		const lastExitCode = Number.isFinite(exitCodeParsed) ? exitCodeParsed : undefined;
		return {
			running: runningStr === 'true',
			image,
			containerId,
			...(lastExitCode !== undefined ? { lastExitCode } : {}),
		};
	});

// -----------------------------------------------------------------------------
// Pure decision
// -----------------------------------------------------------------------------

/**
 * Outcome of `decideRunAction` — what the dispatcher should do next. The
 * fifth logical state ("resume failed, fall back to recreate") is a
 * RUNTIME promotion done by the dispatcher; the pure function only
 * emits the four entry-point actions.
 */
export type RunAction =
	| { readonly kind: 'adopt'; readonly containerId: string }
	| { readonly kind: 'resume'; readonly containerId: string }
	| { readonly kind: 'recreate'; readonly existingId?: string; readonly reason: RecreateReason }
	| { readonly kind: 'fresh' };

/**
 * Why a `recreate` action was chosen. Surfaced so the `run` callback can
 * decide whether to log a banner / change behavior (e.g. Docker.run logs
 * an UNCLEAN_PRIOR_SHUTDOWN error for the SIGKILL case).
 */
export type RecreateReason =
	| 'image-mismatch'
	| 'unclean-shutdown'
	// Promoted at runtime by the dispatcher after `docker start` fails on a
	// resume branch. Exposed here so the recreate path can branch on it
	// (Docker.run auto-allocates host ports ONLY for this reason when the
	// start failure was a port-conflict stderr).
	| 'resume-failed';

/**
 * Pure decision: which action describes what to do for this
 * `(inspected, requestedImage)` pair?
 *
 *   - `inspected === null`                              → `fresh`
 *   - prior run ended in SIGKILL (exit 137) AND not in
 *     `expectedExitCodes`                              → `recreate(unclean-shutdown)`
 *   - same image, running                              → `adopt`
 *   - same image, stopped                              → `resume`
 *   - different image (running or stopped)             → `recreate(image-mismatch)`
 *
 * UNCLEAN_PRIOR_SHUTDOWN takes precedence over adopt/resume — stateful
 * services that exit 137 leave on-disk state inconsistent in ways that
 * naive resume can't recover from. The `expectedExitCodes` opt-out is
 * for primitives that exit 137 BY DESIGN and have a workload-internal
 * recovery path (sui-localnet is the canonical case).
 */
export const decideRunAction = (
	inspected: InspectResult | null,
	requestedImage: string,
	expectedExitCodes: ReadonlyArray<number> = [],
): RunAction => {
	if (inspected === null) return { kind: 'fresh' };
	if (inspected.image !== requestedImage) {
		return {
			kind: 'recreate',
			existingId: inspected.containerId,
			reason: 'image-mismatch',
		};
	}
	if (inspected.lastExitCode === 137 && !expectedExitCodes.includes(inspected.lastExitCode)) {
		return {
			kind: 'recreate',
			existingId: inspected.containerId,
			reason: 'unclean-shutdown',
		};
	}
	if (inspected.running) return { kind: 'adopt', containerId: inspected.containerId };
	return { kind: 'resume', containerId: inspected.containerId };
};

// -----------------------------------------------------------------------------
// Public spec / result
// -----------------------------------------------------------------------------

/**
 * Why the helper is asking the caller's `run` callback to spawn a fresh
 * container. Lets the callback adjust argv (e.g. Docker.run swaps host
 * ports for auto-allocated ports on `recreate` with `recreateReason ===
 * 'resume-failed'` when the start failure was a port conflict) without
 * re-implementing the decision logic outside the helper.
 */
export interface RunContext {
	readonly reason: 'fresh' | 'recreate';
	/** Refined `recreate` reason. `undefined` when `reason === 'fresh'`. */
	readonly recreateReason?: RecreateReason;
	/** Stderr from the failed `docker start` when this is a
	 *  `recreate-resume-failed` invocation. `undefined` for every other
	 *  reason. Callers (Docker.run) use this to detect port-conflict
	 *  stderr patterns and switch port-arg generation accordingly. */
	readonly resumeFailureStderr?: string;
}

/**
 * Spec passed to `ensureContainer`. The `run` callback is the only piece
 * of caller-specific behavior — it owns building the actual `docker run`
 * argv (port mappings, volume mounts, labels, etc.) and returns the new
 * container's id on success. Failures escalate as `DockerError`.
 */
export interface EnsureContainerSpec {
	readonly name: string;
	readonly image: string;
	/**
	 * Spawn a fresh container with whatever argv the caller's policy
	 * needs (`-p host:container`, `-v host:container`, `--label`,
	 * `--entrypoint`, etc.). Must call `docker run -d --name <name>` so
	 * the helper's name-collision recovery can adopt-via-`docker start`
	 * on exit 125. Returns the new container id (the trimmed stdout of
	 * `docker run -d`).
	 *
	 * The helper handles:
	 *   - Calling this AFTER `docker rm -f` on a `recreate` action.
	 *   - Recovering from `docker run` exit 125 + "already in use" by
	 *     adopting via `docker start <name>` (a peer beat us to the
	 *     create).
	 */
	readonly run: (ctx: RunContext) => Effect.Effect<string, DockerError, never>;
	/** Exit codes from the container's previous run that should be treated
	 *  as a clean shutdown — passed through to `decideRunAction`. Defaults
	 *  to `[]`. sui-localnet passes `[137]` to keep warm-resume working
	 *  through its by-design SIGKILL exit. */
	readonly expectedExitCodes?: ReadonlyArray<number>;
	/** Hook fired when an existing container is being adopted (running,
	 *  same image). Caller can use this for diagnostics / logging. Errors
	 *  swallowed; runs uninterrupted. */
	readonly onAdopt?: (containerId: string) => Effect.Effect<void, never>;
	/** Hook fired AFTER a successful `docker start` (resume path). */
	readonly onResume?: (containerId: string) => Effect.Effect<void, never>;
	/** Hook fired when the helper has decided to recreate. Caller can
	 *  log a recreate banner / capture metrics. The recreate `run`
	 *  callback will be invoked AFTER this hook. */
	readonly onRecreate?: (
		reason: RecreateReason,
		existingId: string | undefined,
	) => Effect.Effect<void, never>;
}

/**
 * What `ensureContainer` resolves to. `reused` is `true` when the
 * existing container was adopted or resumed (no `run` callback fired);
 * `false` after a fresh / recreate path. `resumed` distinguishes the
 * `adopt` (was already running) and `resume` (`docker start` succeeded)
 * branches.
 */
export interface EnsureContainerResult {
	readonly containerId: string;
	readonly reused: boolean;
	readonly resumed: boolean;
	/** What `docker inspect` reported BEFORE the helper acted. `null`
	 *  when no container by that name existed. Surfaced so callers can
	 *  observe e.g. the `lastExitCode` for UNCLEAN_PRIOR_SHUTDOWN
	 *  diagnostics. */
	readonly inspected: InspectResult | null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Match docker-style "already in use" name-collision stderr. docker
// emits exit 125 with `Conflict. The container name "..." is already in
// use by container "..."` when two creates race on the same `--name`.
// Lowercase-substring match — stable wording across docker / podman /
// containerd surfaces we've seen in the wild.
const NAME_COLLISION_PATTERNS = ['already in use', 'name is already in use'] as const;

const isNameCollisionStderr = (exitCode: number, stderr: string): boolean => {
	// Exit 125 is docker's "daemon refused the command" exit class, of
	// which name-collision is one variant. We additionally require the
	// stderr substring so we don't misclassify an OCI runtime failure or
	// invalid-mount error (also exit 125) as a collision.
	if (exitCode !== 125) return false;
	const lower = stderr.toLowerCase();
	return NAME_COLLISION_PATTERNS.some((p) => lower.includes(p));
};

// `docker start` "no such container" — stable wording across daemon
// versions. Used to detect a TOCTOU window between the inspect probe
// and our start attempt (Bug C — a peer's finalizer rm'd the container
// in between).
const isNoSuchContainerStderr = (stderr: string): boolean => /No such container/i.test(stderr);

// Force-remove a container by exact name. Best-effort: failure here
// (container already gone, daemon hiccup) falls through to the caller's
// `run` callback which will surface the real reason if there's still a
// blocker. The `^/<name>$` anchor guards against substring matches
// against unrelated containers.
const removeContainerByNameBestEffort = (
	spawner: Spawner,
	name: string,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', ['ps', '-a', '-q', '--filter', `name=^/${name}$`]);
		const ls = yield* runCapturing(spawner, lsCmd, 'docker ps').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (ls === null) return;
		const ids = ls.stdout
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (ids.length === 0) return;
		for (const id of ids) {
			yield* runCapturing(spawner, ChildProcess.make('docker', ['rm', '-f', id]), 'docker rm').pipe(
				Effect.ignore,
			);
		}
	});

// Result tag mirrors the pre-E1 sui-build-container split: 'started' /
// 'missing' lets the caller fall back to the create branch on TOCTOU,
// instead of swallowing the underlying failure and leaving the
// container in an indeterminate state.
type DockerStartResult =
	| { readonly tag: 'started' }
	| { readonly tag: 'missing'; readonly stderr: string }
	| { readonly tag: 'failed'; readonly exitCode: number; readonly stderr: string };

const dockerStart = (
	spawner: Spawner,
	idOrName: string,
): Effect.Effect<DockerStartResult, DockerError> =>
	Effect.gen(function* () {
		const captured = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['start', idOrName]),
			'docker start',
		);
		if (captured.exitCode === 0) return { tag: 'started' };
		if (isNoSuchContainerStderr(captured.stderr)) {
			return { tag: 'missing', stderr: captured.stderr };
		}
		return {
			tag: 'failed',
			exitCode: captured.exitCode,
			stderr: captured.stderr,
		};
	});

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Adopt / resume / recreate / fresh — one race-safe state machine for
 * all long-running container primitives. See module docstring for the
 * full design rationale.
 *
 * The helper does NOT register a stop / rm finalizer — that's the
 * caller's job (Docker.run wires it onto a scope, sui-build-container
 * registers `docker rm -f` at supervisor teardown). The helper just
 * returns the container id and a tag describing what it did.
 */
export const ensureContainer = (
	spec: EnsureContainerSpec,
): Effect.Effect<EnsureContainerResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> => {
	const lock = lockFor(spec.name);
	return lock.withPermits(1)(ensureContainerLocked(spec)).pipe(
		Effect.withSpan('ensureContainer', { attributes: { 'docker.name': spec.name } }),
	);
};

const ensureContainerLocked = (
	spec: EnsureContainerSpec,
): Effect.Effect<EnsureContainerResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const inspected = yield* inspectContainerByName(spawner, spec.name);
		const initialAction = decideRunAction(inspected, spec.image, spec.expectedExitCodes);

		// ── Adopt path ──
		if (initialAction.kind === 'adopt') {
			if (spec.onAdopt) yield* spec.onAdopt(initialAction.containerId);
			return {
				containerId: initialAction.containerId,
				reused: true,
				resumed: false,
				inspected,
			};
		}

		// ── Resume path ──
		// May promote to `fresh` (TOCTOU) or `recreate` (real failure).
		let effectiveAction: RunAction = initialAction;
		let resumeFailureStderr: string | undefined;
		if (initialAction.kind === 'resume') {
			const startResult = yield* dockerStart(spawner, initialAction.containerId);
			if (startResult.tag === 'started') {
				if (spec.onResume) yield* spec.onResume(initialAction.containerId);
				return {
					containerId: initialAction.containerId,
					reused: true,
					resumed: true,
					inspected,
				};
			}
			if (startResult.tag === 'missing') {
				// TOCTOU recovery — a peer (or this process's prior
				// finalizer) `docker rm`d the container between our
				// inspect and our start. Fall through to the create
				// branch by promoting to `fresh`.
				yield* Effect.logInfo(
					`devstack: container '${spec.name}' vanished between inspect and start ` +
						`(TOCTOU); falling back to fresh create`,
				);
				effectiveAction = { kind: 'fresh' };
			} else {
				// Real start failure — promote to `recreate-resume-failed`.
				// The dispatcher's recreate branch will rm + invoke
				// `run({reason: 'recreate', recreateReason: 'resume-failed',
				// resumeFailureStderr})` so the caller can decide whether
				// to alter argv (port re-allocation, banner logging, etc.).
				yield* Effect.logWarning(
					`devstack: docker start '${spec.name}' failed (exit=${startResult.exitCode}, ` +
						`stderr=${startResult.stderr.trim().slice(0, 200)}) — falling back to recreate`,
				);
				resumeFailureStderr = startResult.stderr;
				effectiveAction = {
					kind: 'recreate',
					existingId: initialAction.containerId,
					reason: 'resume-failed',
				};
			}
		}

		// ── Recreate path ──
		if (effectiveAction.kind === 'recreate') {
			if (spec.onRecreate)
				yield* spec.onRecreate(effectiveAction.reason, effectiveAction.existingId);
			// Stale-container cleanup — name-collision recovery in
			// `createWithCollisionFallback` handles the case where a peer
			// recreated under the same name between our rm and our run.
			yield* removeContainerByNameBestEffort(spawner, spec.name);
			const runCtx: RunContext = {
				reason: 'recreate',
				recreateReason: effectiveAction.reason,
				...(resumeFailureStderr !== undefined ? { resumeFailureStderr } : {}),
			};
			const containerId = yield* createWithCollisionFallback(spawner, spec, runCtx);
			return { containerId, reused: false, resumed: false, inspected };
		}

		// ── Fresh path ──
		// (Either the original decision was `fresh` OR the resume-TOCTOU
		// branch promoted us here.)
		const runCtx: RunContext = { reason: 'fresh' };
		const containerId = yield* createWithCollisionFallback(spawner, spec, runCtx);
		return { containerId, reused: false, resumed: false, inspected };
	});

// Invoke the caller's `run` callback, with name-collision recovery: when
// a peer beat us to the same `--name` (docker exit 125 + "already in
// use"), adopt the peer's container via `docker start`. Single-shot
// fallback: a second collision (or a missing container on the start
// fallback) indicates destructive racing, so we propagate a typed error
// instead of looping.
const createWithCollisionFallback = (
	spawner: Spawner,
	spec: EnsureContainerSpec,
	ctx: RunContext,
): Effect.Effect<string, DockerError> =>
	spec.run(ctx).pipe(
		Effect.catchTag('DockerError', (err) =>
			Effect.gen(function* () {
				// Detect name-collision by inspecting the DockerError's stderr +
				// exitCode envelope. The caller's `run` callback funnels its
				// docker-run failure through DockerError carrying these fields
				// (Docker.run's `runCapturing` envelope, sui-build's adapter).
				const exitCode = err.exitCode ?? -1;
				const stderr = err.stderr ?? '';
				if (!isNameCollisionStderr(exitCode, stderr)) {
					return yield* Effect.fail(err);
				}
				// Adopt the peer's container.
				yield* Effect.logInfo(
					`devstack: container '${spec.name}' lost the create race to a peer ` +
						`(exit ${exitCode}, "already in use"); adopting via docker start`,
				);
				const startResult = yield* dockerStart(spawner, spec.name);
				if (startResult.tag === 'started') {
					// Need to read the id back since the peer's `run` didn't
					// give it to us. Re-inspect by name.
					const inspected = yield* inspectContainerByName(spawner, spec.name);
					if (inspected === null) {
						return yield* Effect.fail(
							new DockerError({
								phase: 'docker start (collision recovery)',
								message:
									`container '${spec.name}' missing after start during collision recovery; ` +
									`a peer concurrently removed it`,
							}),
						);
					}
					return inspected.containerId;
				}
				if (startResult.tag === 'missing') {
					return yield* Effect.fail(
						new DockerError({
							phase: 'docker start (collision recovery)',
							message:
								`container '${spec.name}' vanished during collision-recovery start. ` +
								`A peer supervisor likely created it then removed it concurrently. ` +
								`Retry; if persistent, stop other devstack invocations against this name.`,
							stderr: truncate(startResult.stderr),
						}),
					);
				}
				return yield* Effect.fail(
					new DockerError({
						phase: 'docker start (collision recovery)',
						message: summarize(
							'docker start',
							startResult.exitCode,
							'',
							startResult.stderr,
							`name=${spec.name}`,
						),
						exitCode: startResult.exitCode,
						stderr: truncate(startResult.stderr),
					}),
				);
			}),
		),
	);
