// Seal lifted sibling — vendored-Dockerfile docker image.
//
// Naming legacy: the sibling is keyed `kind: 'cargo-image'` because
// the v3 implementation cargo-built the seal workspace from source.
// The redesign DELIBERATELY skips the cargo build — the upstream
// seal release ships pre-built `seal-cli` + `key-server` binaries
// per platform, and our vendored Dockerfile at
// `images/seal/Dockerfile` just fetches and packages them. First
// build is ~30s vs. the ~5-8 min cargo path. The `cargo-image` key
// shape is kept so the dedup namespace stays compatible with
// walrus's matching sibling.
//
// Lifted-sibling key conventions:
//
//   - `plugin`     — `'seal'`. The image is seal-specific: contains
//                    the `seal-cli` + `key-server` binaries from the
//                    Mysten/seal GitHub release. Distinct from
//                    walrus's image (which contains walrus binaries),
//                    so we keep these in separate `plugin` namespaces.
//
//                    Distilled-doc §"Lifted siblings" rationale:
//                    `sealImage` lives under the seal plugin's
//                    namespace because no other plugin produces an
//                    image with these binaries. Cross-plugin sharing
//                    would only make sense for a sibling that
//                    actually consumes seal binaries (none today).
//
//   - `kind`       — `'cargo-image'`. Historical label. The redesign
//                    no longer cargo-builds; the vendored Dockerfile
//                    fetches the release binaries. An analogous
//                    sibling under the walrus plugin has the same
//                    `kind` (substrate-blind — different plugins
//                    don't dedup, regardless of kind).
//
//   - `scope`      — `'per-process'`. Mirrors walrus's choice: the
//                    image cache is content-addressed by docker; one
//                    tag works across every stack on the host. The
//                    topo scheduler still places the sibling at level
//                    0 (parallel with sui's boot) within a process.
//
//   - `inputHash`  — `litHash(`${ref}|${sealCliVersion}|${rustToolchain}`)`.
//                    Distilled-doc invariant #11 — version + repo
//                    + Dockerfile content together pin the build.
//                    `rustToolchain` is kept in the hash for
//                    historical compat with walrus's sibling shape
//                    even though we no longer compile.
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
import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';
import { sealError, type SealError } from '../errors.ts';
import { DEFAULT_SEAL_REPO, DEFAULT_SEAL_VERSION } from './source-fetch.ts';

// ---------------------------------------------------------------------------
// Sibling key constructor
// ---------------------------------------------------------------------------

export const SEAL_CARGO_IMAGE_PLUGIN = 'seal' as const;
export const SEAL_CARGO_IMAGE_KIND = 'cargo-image' as const;

/** Pinned rust toolchain for the upstream seal cargo build. Distilled-
 *  doc §Configuration defaults block. Pinned to match walrus's default
 *  so a shared rust:1.93 builder image can fan out builds. */
export const DEFAULT_SEAL_RUST_TOOLCHAIN = '1.93' as const;

/** Inputs to the cargo-image sibling — knowable at factory time, hence
 *  type-level dedup is possible. */
export interface SealCargoImageInputs<Ref extends string = string, RustV extends string = string> {
	readonly sealRepo: typeof DEFAULT_SEAL_REPO;
	readonly sealRef: Ref;
	readonly rustToolchain: RustV;
}

export type SealCargoImageKey<Hash extends string> = LitSiblingKey<
	typeof SEAL_CARGO_IMAGE_PLUGIN,
	typeof SEAL_CARGO_IMAGE_KIND,
	'per-process',
	Hash
>;

/** Compute the literal-typed sibling key. The literal-string hash
 *  preserves the `(ref, toolchain)` tuple at the type level so the
 *  compiler can dedup at compose time. */
export const sealCargoImageSiblingKey = <Ref extends string, RustV extends string>(
	sealRef: Ref,
	rustToolchain: RustV,
): SealCargoImageKey<`${Ref}|${RustV}`> =>
	litSiblingKey(
		SEAL_CARGO_IMAGE_PLUGIN,
		SEAL_CARGO_IMAGE_KIND,
		'per-process',
		`${sealRef}|${rustToolchain}` as const,
	);

/** Construct the sibling key for the default `(sealRef, toolchain)`. */
export const defaultSealCargoImageSiblingKey = () =>
	sealCargoImageSiblingKey(DEFAULT_SEAL_VERSION, DEFAULT_SEAL_RUST_TOOLCHAIN);

/** Back-compat alias — earlier skeleton named it `sealCargoImageKey`. */
export const sealCargoImageKey = <Hash extends string>(
	inputHash: Hash,
): LitSiblingKey<
	typeof SEAL_CARGO_IMAGE_PLUGIN,
	typeof SEAL_CARGO_IMAGE_KIND,
	'per-process',
	Hash
> => litSiblingKey(SEAL_CARGO_IMAGE_PLUGIN, SEAL_CARGO_IMAGE_KIND, 'per-process', inputHash);

// ---------------------------------------------------------------------------
// Resolved value
// ---------------------------------------------------------------------------

/** Resolved value the sibling produces — the content-addressed
 *  image ref the long-running container references via
 *  `image:` in its spec. */
export interface SealCargoImageResolved {
	readonly imageTag: string;
	readonly digest: string;
	readonly version: string;
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
