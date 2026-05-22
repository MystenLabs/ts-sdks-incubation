// Seal vendored-Dockerfile docker image.
//
// The upstream seal release ships pre-built `seal-cli` + `key-server`
// binaries per platform, and our vendored Dockerfile at
// `images/seal/Dockerfile` just fetches and packages them.
//
// Resolution paths (mirror walrus's two-stage dispatch — distilled-doc
// §"Pinned upstream version" + §"Optional pre-built image tag override"):
//
//   (a) `SEAL_CARGO_IMAGE_OVERRIDE` env — points at a pre-baked
//        registry tag (or a locally-tagged image like `seal-test-stub:latest`).
//        Skips the docker build entirely. The on-disk image is
//        content-addressed by the registry; we just thread it through.
//
//   (b) Real build via `runtime.ensureImage({ contextPath,
//        dockerfile: 'Dockerfile', buildArgs: { SEAL_VERSION } })`
//        against the vendored Dockerfile at `images/seal/`. Mirrors
//        the sui plugin's `resolveImage` shape.

import { Effect, type Scope } from 'effect';

import type {
	ContainerBuildContext,
	ContainerRuntime,
	ImageRef,
} from '../../../contracts/container-runtime.ts';
import { sealError, type SealError } from '../errors.ts';
import { DEFAULT_SEAL_REPO, DEFAULT_SEAL_VERSION } from './source-fetch.ts';

// ---------------------------------------------------------------------------
/** Pinned rust toolchain for the upstream seal cargo build. Distilled-
 *  doc §Configuration defaults block. Pinned to match walrus's default
 *  so a shared rust:1.93 builder image can fan out builds. */
export const DEFAULT_SEAL_RUST_TOOLCHAIN = '1.93' as const;

/** Inputs to the seal image resolver. */
export interface SealCargoImageInputs<Ref extends string = string, RustV extends string = string> {
	readonly sealRepo: typeof DEFAULT_SEAL_REPO;
	readonly sealRef: Ref;
	readonly rustToolchain: RustV;
}

// ---------------------------------------------------------------------------
// Runtime resolver
// ---------------------------------------------------------------------------

/** Resolve the seal image. Two staged paths:
 *
 *   (a) `SEAL_CARGO_IMAGE_OVERRIDE` env var — points at a pre-baked
 *        registry tag (or a locally-built fixture image like
 *        `seal-test-stub:latest`). Skips the docker build entirely
 *        and returns a bare `ImageRef` synthesized from the override
 *        tag. CI bakes the image once + pins the tag; the local-
 *        keygen boot just reads the env.
 *
 *   (b) Real build via `runtime.ensureImage` against the vendored
 *        Dockerfile at `packages/devstack/images/seal/`. The
 *        Dockerfile is a binary-fetch path (NOT a cargo compile) —
 *        the seal release workflow ships pre-built per-platform
 *        binaries (`seal-cli`, `key-server`) and we just fetch +
 *        package them. Build is content-addressed by docker; same
 *        Dockerfile + same SEAL_VERSION → same image hash. */
export const resolveSealCargoImage = (
	runtime: ContainerRuntime,
	inputs: SealCargoImageInputs,
): Effect.Effect<ImageRef, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const override = (globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env?.SEAL_CARGO_IMAGE_OVERRIDE;
		if (override && override.length > 0) {
			// Trust-the-tag path. Compose the resolved shape from the
			// pinned tag — the digest is opaque (substrate's
			// content-addressed cache will re-resolve via `docker
			// inspect` when it materializes the image).
			return { digest: override, tag: override } satisfies ImageRef;
		}
		// Vendored-Dockerfile path. Same shape as sui's `resolveImage`
		// (plugins/sui/mode/local.ts:resolveImage). Context is `images/`
		// (NOT `images/seal/`) so the Dockerfile can `COPY` the shared
		// `_shared/signal-forward.sh` snippet alongside the seal-specific
		// entrypoint. The Dockerfile builds in two stages: (1) ubuntu
		// base, fetch + chmod the per-arch binaries from the seal release
		// URL; (2) debian:bookworm-slim runtime with the signal-
		// forwarding entrypoint shell wrapped around `key-server`.
		const buildCtx: ContainerBuildContext = {
			contextPath: new URL('../../../../images/', import.meta.url).pathname,
			dockerfile: 'seal/Dockerfile',
			buildArgs: { SEAL_VERSION: inputs.sealRef },
		};
		return yield* runtime.ensureImage(buildCtx).pipe(
			Effect.mapError((cause) =>
				sealError('image', {
					name: 'seal',
					message:
						`seal image build failed: ${cause.reason}: ${cause.detail}. ` +
						`SEAL_VERSION=${inputs.sealRef} (from ${inputs.sealRepo}/releases). ` +
						`Set SEAL_CARGO_IMAGE_OVERRIDE=<tag> to bypass the build.`,
					cause,
				}),
			),
		);
	}).pipe(
		Effect.withSpan('devstack.plugin.seal.cargoImage.resolve', {
			attributes: {
				'seal.ref': inputs.sealRef,
				'seal.rustToolchain': inputs.rustToolchain,
			},
		}),
	);

/** Convenience: resolve via the default inputs. */
export const resolveDefaultSealCargoImage = (
	runtime: ContainerRuntime,
): Effect.Effect<ImageRef, SealError, Scope.Scope> =>
	resolveSealCargoImage(runtime, {
		sealRepo: DEFAULT_SEAL_REPO,
		sealRef: DEFAULT_SEAL_VERSION,
		rustToolchain: DEFAULT_SEAL_RUST_TOOLCHAIN,
	});
