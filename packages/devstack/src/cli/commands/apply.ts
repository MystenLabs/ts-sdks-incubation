// `devstack apply` — one-shot reconcile.
//
// Boots the user's devstack config exactly like `up`, but instead of
// `Layer.launch`-ing into a long-running fiber, we acquire the layer via
// `Layer.build` inside `Effect.scoped`. That builds every primitive
// (state.json is repopulated, manifest finalizer is registered), then
// the surrounding scope closes which fires the manifest finalizer and
// tears everything down. The CLI exits.
//
// Useful for CI: bring the stack up, write state + manifest, exit clean.

import { Cause, Console, Effect, Layer, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { SeedManifestMismatchError } from '../../engine/errors.js';
import { causeToJson, prettyError } from '../../engine/pretty-error.js';
import { bootstrapRouterFor } from '../../engine/router-bootstrap.js';
import { AlreadyReportedError } from '../already-reported.js';
import { emitEnvelope, errorEnvelope, jsonModeEnabled, successEnvelope } from '../envelope.js';
import { EX_DATAERR } from '../exit-codes.js';
import { applyNetworkOverride, networkFlag } from '../flags.js';
import { loadConfigModule, requireLayer } from '../loaders.js';

/** Walk the cause tree for a `SeedManifestMismatchError`. The error
 *  surfaces at fork-acquire time deep inside the supervisor's Layer
 *  build pipeline, so the apply-level `Effect.catch` sees it wrapped
 *  in arbitrary cause envelopes. Mirrors the walk pattern in
 *  `already-reported.ts:causeHasAlreadyReported`. */
const findSeedManifestMismatch = (cause: unknown): SeedManifestMismatchError | undefined => {
	if (cause instanceof SeedManifestMismatchError) return cause;
	if (cause === null || typeof cause !== 'object') return undefined;
	if (Cause.isCause(cause)) {
		for (const reason of (cause as Cause.Cause<unknown>).reasons) {
			if (!Cause.isFailReason(reason)) continue;
			const found = findSeedManifestMismatch(reason.error);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	const obj = cause as { cause?: unknown; _tag?: unknown };
	if (obj._tag === 'SeedManifestMismatchError') return cause as SeedManifestMismatchError;
	if (obj.cause !== undefined) return findSeedManifestMismatch(obj.cause);
	return undefined;
};

const renderSeedMismatchRecipe = (err: SeedManifestMismatchError): string => {
	const lines: Array<string> = [
		`apply failed: fork seed manifest mismatch`,
		``,
		`  on-disk meta:  ${err.metaPath}`,
	];
	if (err.previous !== undefined && err.current !== undefined) {
		lines.push(
			`  previous:      upstream=${err.previous.upstream ?? '<missing>'}` +
				(err.previous.checkpoint !== undefined ? `, checkpoint=${err.previous.checkpoint}` : '') +
				(err.previous.configHash !== undefined ? `, hash=${err.previous.configHash}` : ''),
		);
		lines.push(
			`  current:       upstream=${err.current.upstream ?? '<missing>'}` +
				(err.current.checkpoint !== undefined ? `, checkpoint=${err.current.checkpoint}` : '') +
				(err.current.configHash !== undefined ? `, hash=${err.current.configHash}` : ''),
		);
	}
	lines.push(``);
	lines.push(`  To resolve, wipe the per-stack fork state while keeping the shared`);
	lines.push(`  upstream cache so the next boot doesn't re-download from scratch:`);
	lines.push(``);
	lines.push(`    devstack wipe --keep-upstream-cache --yes && devstack apply`);
	return lines.join('\n');
};

export const applyCommand = Command.make(
	'apply',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		json: Flag.boolean('json'),
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription(
				'Resolve the config and report the planned configPath/manifest path; do not build any layers.',
			),
			Flag.withDefault(false),
		),
		network: networkFlag,
	},
	({ configPath, json, dryRun, network }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			applyNetworkOverride(network);
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadConfigModule(resolved, requireLayer);

			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'apply',
							data: {
								configPath: resolved,
								wouldApply: { configPath: resolved },
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(`apply dry-run: would reconcile ${resolved} (no layers built)`);
				}
				return;
			}

			// Bring up the shared traefik router BEFORE building the user
			// stack. On a fresh CI runner (no prior `devstack up` on this
			// host) the `devstack-router` docker network does NOT exist
			// yet — `ensureRouter` is what creates it. Skipping this step
			// causes per-primitive `docker network connect devstack-router`
			// calls to fail silently inside Docker.run's traefik wiring
			// (only logged as WARN), after which traefik-fronted ready-probes
			// time out 60s later because the manifest URLs are unreachable.
			//
			// `up` does the same thing inside the long-running supervisor
			// (`runDevstack` at supervisor.ts ~ ensureRouter call) — the
			// helper is shared so the two paths can't drift on the
			// timeout / fallback / opt-out envelope.
			//
			// We supply `NodeServicesLayer` here directly (rather than
			// composing the full bootstrap layer) because `ensureRouter`
			// only needs `ChildProcessSpawner` — pulling in the rest of
			// the bootstrap services would couple `apply` to identity /
			// state-store / engine wiring it doesn't otherwise need.
			yield* bootstrapRouterFor('apply').pipe(Effect.provide(NodeServicesLayer));

			// `Layer.build` inside `Effect.scoped` acquires every primitive,
			// then closes the scope on exit — that's what fires the manifest
			// finalizer (and every other teardown registered during acquire).
			const buildEffect = Effect.gen(function* () {
				yield* Layer.build(devstack.layer);
			}).pipe(Effect.scoped) as Effect.Effect<void, unknown, never>;

			// Render success/failure ourselves so `--json` can emit a
			// structured summary instead of letting the CLI runtime swallow
			// the error through its default handler. The Effect still fails
			// at the end on error so the process exits non-zero — but we
			// raise `AlreadyReportedError` instead of re-failing with the
			// raw cause so the top-level `tapCause` doesn't double-print.
			const reportAndRethrow = (cause: unknown) =>
				Effect.gen(function* () {
					// Typed catch for SeedManifestMismatchError. The
					// supervisor's fork-acquire path can't silently fall
					// back when the on-disk meta disagrees with the current
					// config, so we render an actionable wipe-and-retry
					// recipe BEFORE
					// the generic pretty-error rendering. JSON mode
					// includes the same structured fields under
					// `error.context.seedManifestMismatch` (canonical
					// envelope) so CI consumers can programmatically
					// distinguish this failure mode from a network blip
					// or docker hiccup.
					const seedMismatch = findSeedManifestMismatch(cause);
					if (useJson) {
						const seedContext =
							seedMismatch !== undefined
								? {
										metaPath: seedMismatch.metaPath,
										...(seedMismatch.previous !== undefined
											? { previous: seedMismatch.previous }
											: {}),
										...(seedMismatch.current !== undefined
											? { current: seedMismatch.current }
											: {}),
									}
								: undefined;
						yield* emitEnvelope(
							errorEnvelope({
								command: 'apply',
								error: {
									code:
										seedMismatch !== undefined ? 'SEED_MANIFEST_MISMATCH' : 'APPLY_FAILED',
									exitCode: EX_DATAERR,
									message:
										seedMismatch !== undefined
											? 'fork seed manifest mismatch — on-disk meta differs from current config'
											: 'apply failed',
									...(seedMismatch !== undefined
										? {
												hint: 'devstack wipe --keep-upstream-cache --yes && devstack apply',
												recipe: 'devstack wipe --keep-upstream-cache --yes && devstack apply',
												context: { configPath: resolved, seedManifestMismatch: seedContext },
											}
										: { context: { configPath: resolved } }),
									cause: causeToJson(cause),
								},
								elapsedMs: Date.now() - startedAt,
							}),
						);
					} else if (seedMismatch !== undefined) {
						yield* Console.error(renderSeedMismatchRecipe(seedMismatch));
					} else {
						yield* Console.error(`apply failed:\n${prettyError(cause)}`);
					}
					return yield* Effect.fail(new AlreadyReportedError({ cause }));
				});

			yield* buildEffect.pipe(Effect.catch(reportAndRethrow));

			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'apply',
						data: { configPath: resolved },
						elapsedMs: Date.now() - startedAt,
					}),
				);
			} else {
				yield* Console.log(`apply ok — state + manifest written for ${resolved}`);
			}
		}),
).pipe(
	Command.withDescription(
		'One-shot reconcile: build the stack, write state.json + manifest.json, exit',
	),
);
