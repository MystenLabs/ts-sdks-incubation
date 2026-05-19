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
		network: networkFlag,
	},
	({ configPath, json, network }) =>
		Effect.gen(function* () {
			applyNetworkOverride(network);
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadConfigModule(resolved, requireLayer);

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
					// Typed catch for SeedManifestMismatchError — Phase 4
					// P4.10. The supervisor's fork-acquire path can't
					// silently fall back when the on-disk meta disagrees
					// with the current config (R6 mitigation), so we
					// render an actionable wipe-and-retry recipe BEFORE
					// the generic pretty-error rendering. JSON mode
					// includes the same structured fields under
					// `error.seedManifestMismatch` so CI consumers can
					// programmatically distinguish this failure mode
					// from a network blip or docker hiccup.
					const seedMismatch = findSeedManifestMismatch(cause);
					if (json) {
						yield* Console.log(
							JSON.stringify({
								ok: false,
								command: 'apply',
								configPath: resolved,
								error: causeToJson(cause),
								...(seedMismatch !== undefined
									? {
											seedManifestMismatch: {
												metaPath: seedMismatch.metaPath,
												...(seedMismatch.previous !== undefined
													? { previous: seedMismatch.previous }
													: {}),
												...(seedMismatch.current !== undefined
													? { current: seedMismatch.current }
													: {}),
												recipe: 'devstack wipe --keep-upstream-cache --yes && devstack apply',
											},
										}
									: {}),
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

			if (json) {
				yield* Console.log(
					JSON.stringify({
						ok: true,
						command: 'apply',
						configPath: resolved,
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
