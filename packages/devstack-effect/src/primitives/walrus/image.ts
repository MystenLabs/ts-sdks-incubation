// Walrus phase 1 — wrapper image build.
//
// Layers a matching sui binary + the vendored `deploy.sh` / `run.sh`
// scripts on top of the upstream cargo-built walrus image. Split out of
// `internal.ts` along the phase boundary so the orchestrator stays
// small; the upstream image factory (`dockerImage(...)`) lives in
// `local-cluster.ts` since its `BASE_IMAGE` build-arg only resolves at
// runtime from the orchestrator's `yield* args.upstreamImage`.
//
// Span: `walrus.image` (preserved from the monolithic revision).

import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import * as Docker from '../../internal/docker.js';
import { WalrusError } from '../errors.js';

// Build the wrapper image that layers a matching sui binary + the
// vendored `deploy.sh` / `run.sh` scripts on top of the upstream
// cargo-built walrus image. We can't run this through the
// `dockerImage({build})` factory because the wrapper's `BASE_IMAGE`
// build-arg is the upstream's content-addressed tag, which only
// resolves at runtime — `dockerImage` captures `buildArgs` by closure
// at factory call time. Calling `Docker.build` directly here keeps
// the wrapper's input hash dependent on the upstream's tag so an
// upstream rebuild flips this tag too.
export const buildWrapperImage = (args: {
	name: string;
	context: string;
	baseImage: string;
	suiVersion: string;
}): Effect.Effect<string, WalrusError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.fn('walrus.image')(function* () {
		// Content-addressed tag from a coarse hash of the build inputs.
		// Matches the shape `dockerImage` would produce for the upstream
		// side so the two tags share a consistent naming convention.
		const inputs = {
			context: args.context,
			dockerfile: 'wrapper.Dockerfile',
			buildArgs: { BASE_IMAGE: args.baseImage, SUI_VERSION: args.suiVersion },
		};
		const hash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 12);
		const tag = `devstack-${args.name}.image:${hash}`;
		const result = yield* Docker.build({
			context: args.context,
			dockerfile: 'wrapper.Dockerfile',
			tag,
			buildArgs: { BASE_IMAGE: args.baseImage, SUI_VERSION: args.suiVersion },
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'image',
						message: `walrus.image: failed to build wrapper from BASE_IMAGE='${args.baseImage}': ${cause.message}`,
						cause,
					}),
				),
			),
		);
		return result.tag;
	})();
