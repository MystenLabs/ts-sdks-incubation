// `devstack snapshot save / restore / delete` verb wirings.
//
// `save` is live-aware: when a supervisor owns the stack, publish a
// `snapshot.capture` command and read the structured result from the
// command-channel reply payload (no tail-fiber). `restore` and
// `delete` are direct/offline only; they refuse to run when a
// supervisor is live.

import { dirname } from 'node:path';

import { Effect, Exit, FileSystem, Logger } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';
import {
	commandChannelPaths,
	makeCommandChannelPublisher,
	makeProjectionRef,
	type SupervisedStack,
} from '../../substrate/runtime/index.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
	superviseStackEffect,
} from '../../orchestrators/boot.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotMetadata,
} from '../../orchestrators/snapshot/index.ts';
import { CliInternalError, CliUnavailableError } from '../../surfaces/cli/index.ts';
import { probeSupervisorPresence } from '../../surfaces/cli/commands/index.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { makeConfigLoader, resolveConfigPath } from './config-loader.ts';
import {
	ensureNoLiveSupervisor,
	identityValueFor,
	resolvedIdentityForStack,
	type ResolvedIdentity,
} from './identity.ts';
import { buildDirectSnapshotLayers, buildVerbLayers } from './build-verb-layers.ts';
import { provideFileSystem } from './provide-file-system.ts';

const LIVE_SNAPSHOT_CAPTURE_TIMEOUT_MILLIS = 60 * 60 * 1000;

const mintCliSnapshotId = (): string => `snap-${Date.now()}-${mintRandomSuffix(8)}`;

/** Structured payload that the supervisor's command-channel bridge
 *  attaches to the ack/error reply for `snapshot.capture`. Mirrors the
 *  shape produced by `cli/wirings/up.ts:snapshotCaptureAckFromEvent`. */
interface SnapshotCaptureAckPayload {
	readonly kind: 'captured' | 'failed' | 'skipped';
	readonly snapshotId?: string;
	readonly name?: string;
	readonly summary?: string;
	readonly reason?: string;
}

const isCapturePayload = (value: unknown): value is SnapshotCaptureAckPayload => {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { readonly kind?: unknown }).kind;
	return kind === 'captured' || kind === 'failed' || kind === 'skipped';
};

/** Publish `snapshot.capture` to a live supervisor and surface its
 *  structured ack/error payload. The reply payload carries the
 *  captured metadata (success) or failure summary (failure) — no
 *  side-channel event tail required. Returns `null` if no supervisor
 *  is live so the caller can fall through to the direct path. */
export const runSnapshotCaptureAgainstLiveSupervisor = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string } | null, unknown> =>
	Effect.gen(function* () {
		const presence = yield* probeSupervisorPresence(identity.rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (!presence.live) return null;

		const snapshotId = args.snapshotId ?? mintCliSnapshotId();
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const publisher = yield* makeCommandChannelPublisher(
					commandChannelPaths(identity.stackRoot),
				);
				const published = yield* publisher.publish({
					tag: 'snapshot.capture',
					snapshotId,
					...(args.name === undefined ? {} : { name: args.name }),
				});
				const reply = yield* publisher.awaitCompletion(published, {
					timeoutMillis: LIVE_SNAPSHOT_CAPTURE_TIMEOUT_MILLIS,
				});

				if (reply.ok) {
					const payload = isCapturePayload(reply.payload) ? reply.payload : null;
					if (payload?.kind === 'captured' && typeof payload.snapshotId === 'string') {
						return {
							snapshotId: payload.snapshotId,
							name: payload.name ?? args.name ?? payload.snapshotId,
						};
					}
					// Older supervisor without structured payload (or a peer mock
					// in tests): synthesize from the request — the supervisor
					// already accepted our snapshotId, so it's authoritative.
					return {
						snapshotId,
						name: args.name ?? snapshotId,
					};
				}

				const payload = isCapturePayload(reply.payload) ? reply.payload : null;
				if (payload?.kind === 'skipped') {
					return yield* Effect.fail(
						new CliUnavailableError({
							service: 'snapshot capture',
							message: 'another snapshot capture is already running',
							hint: 'wait for the current snapshot to finish and try again',
						}),
					);
				}
				if (payload?.kind === 'failed') {
					return yield* Effect.fail(
						new CliInternalError({
							message: `snapshot capture failed: ${payload.summary ?? reply.message}`,
						}),
					);
				}
				// No structured payload — surface the raw reply.message.
				if (/already running/i.test(reply.message)) {
					return yield* Effect.fail(
						new CliUnavailableError({
							service: 'snapshot capture',
							message: 'another snapshot capture is already running',
							hint: 'wait for the current snapshot to finish and try again',
						}),
					);
				}
				return yield* Effect.fail(
					new CliUnavailableError({
						service: 'devstack supervisor',
						message: reply.message,
						hint: 'check the attached `devstack up` session and try again',
					}),
				);
			}),
		);
	});

export const runSnapshotRestoreDirect = (
	identity: ResolvedIdentity,
	snapshotId: string,
): Effect.Effect<void, unknown> => {
	const program = Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		// Offline restore: there is NO live supervisor (ensured below), so no
		// plugin contributes a live identity slice. Call `restore` with no
		// `participants` — `runRestore` reads this as "no live stack" and
		// skips ONLY the cross-plugin contribution guard (the snapshot's own
		// recorded identity has nothing live to disagree with). The runtime
		// guard (app/stack/network) and the snapshot-side emptiness refusal
		// still fire. This is the SAME path warm boot + interrupted-restore
		// recovery take, so all three boot-time restores agree. (Previously
		// this synthesized participants from `meta.identity` to make the
		// contribution guard a tautology; that synthesis is now intrinsic to
		// the empty-participants contract.)
		yield* provideFileSystem(fs, snapshot.restore({ id: snapshotId }));
	});
	const restored = program.pipe(
		Effect.provide(
			buildDirectSnapshotLayers({
				identity: identityValueFor(identity),
				runtimeRoot: identity.runtimeRoot,
			}),
		),
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	);
	return ensureNoLiveSupervisor(
		identity,
		'shut down the attached `devstack up` session before restoring a snapshot',
	).pipe(Effect.andThen(restored));
};

export const runSnapshotDeleteDirect = (
	identity: ResolvedIdentity,
	snapshotId: string,
): Effect.Effect<void, unknown> => {
	const program = Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		yield* provideFileSystem(fs, snapshot.delete(snapshotId));
	});
	return program.pipe(
		Effect.provide(
			buildDirectSnapshotLayers({
				identity: identityValueFor(identity),
				runtimeRoot: identity.runtimeRoot,
			}),
		),
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	);
};

const runSnapshotCaptureDirect = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string; readonly configPath?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loaded = yield* loader.load(args.configPath);
		return yield* runSnapshotCaptureDirectLoaded(identity, loaded, args);
	});
};

export const runSnapshotCaptureDirectLoaded = (
	identity: ResolvedIdentity,
	loaded: LoadedConfig,
	args: { readonly snapshotId?: string; readonly name?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> =>
	Effect.gen(function* () {
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const identityValue: Identity = identityValueFor(effectiveIdentity);
		const appRoot = dirname(loaded.resolvedConfigPath);
		const substrateLayers = buildVerbLayers({
			identity: identityValue,
			stack,
			appRoot,
			runtimeRoot: effectiveIdentity.runtimeRoot,
		});

		const program = Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const contributionDispatcher = yield* buildProductionContributionDispatcher();
			const postAcquireHook = yield* buildProductionPostAcquireHook({
				extras: stack.options.extras,
			});
			let captureExit: Exit.Exit<void, unknown> = Exit.succeed(undefined);
			const capturedMeta: { current: SnapshotMetadata | null } = { current: null };
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					contributionDispatcher,
					postAcquireHook,
					lifetime: 'one-shot',
					extendContext: extendBuiltInPluginContext,
					// Offline one-shot capture: the bounce gather → stop → commit →
					// retag → hard-rm runs here; NO `resume` is injected because
					// this supervise scope is `one-shot` (it closes right after) —
					// the NEXT boot is the resume. Direct call to the orchestrator
					// (the former `captureSnapshot` command-primitive is gone).
					withinScope: () =>
						Effect.gen(function* () {
							const snapshot = yield* SnapshotOrchestratorService;
							const fs = yield* FileSystem.FileSystem;
							return yield* snapshot
								.capture({
									...(args.snapshotId === undefined ? {} : { id: args.snapshotId }),
									...(args.name === undefined ? {} : { label: args.name }),
								})
								.pipe(Effect.provideService(FileSystem.FileSystem, fs));
						}).pipe(
							Effect.tap((meta) =>
								Effect.sync(() => {
									capturedMeta.current = meta;
								}),
							),
							Effect.asVoid,
							Effect.exit,
							Effect.tap((exit) =>
								Effect.sync(() => {
									captureExit = exit;
								}),
							),
							Effect.asVoid,
						),
				},
			).pipe(Effect.provide(layerBuiltInPluginRuntime));
			if (Exit.isFailure(captureExit)) {
				yield* Effect.failCause(captureExit.cause);
			}
			if (capturedMeta.current === null) {
				return yield* Effect.die('snapshot capture completed without metadata');
			}
			const meta = capturedMeta.current;
			return { snapshotId: meta.id, name: meta.label ?? meta.id };
		});

		return yield* ensureNoLiveSupervisor(
			effectiveIdentity,
			'shut down the attached `devstack up` session before saving a snapshot',
		).pipe(
			Effect.andThen(
				program.pipe(
					Effect.provide(substrateLayers),
					Effect.provide(Logger.layer([Logger.consolePretty()])),
				),
			),
		);
	});

export const runSnapshotCaptureLiveAware = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string; readonly configPath?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> =>
	Effect.gen(function* () {
		if (args.configPath === undefined && resolveConfigPath(undefined) === null) {
			const live = yield* runSnapshotCaptureAgainstLiveSupervisor(identity, args);
			if (live !== null) return live;
			return yield* runSnapshotCaptureDirect(identity, args);
		}
		const loaded = yield* makeConfigLoader().load(args.configPath);
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const live = yield* runSnapshotCaptureAgainstLiveSupervisor(effectiveIdentity, args);
		if (live !== null) return live;
		return yield* runSnapshotCaptureDirectLoaded(effectiveIdentity, loaded, args);
	});
