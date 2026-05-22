// Walrus lifted sibling — vendored Dockerfile-built walrus image.
//
// Architecture: this is the "upstream image" lifted sibling — placed at
// level 0 in the topo graph so it builds in parallel with sui's boot.
// First-wins dedup across composites with the same key; conflict-refusal
// when two composites pin different versions.
//
// CONTRACT:
//
// The vendored Dockerfile packages the upstream Walrus release tarball
// selected by Docker's TARGETARCH. It never builds Walrus from source:
// upstream release binaries are the contract, and the Dockerfile verifies
// the selected asset before the image is accepted.
//
// Two staged paths:
//
//   (a) `WALRUS_CARGO_IMAGE_OVERRIDE` env var — points at a pre-baked
//        registry tag (or a locally `docker build`-tagged image). Skips
//        the runtime build entirely and returns a bare `ImageRef`. The
//        e2e stub test uses this path (`walrus-test-stub:latest`).
//
//   (b) Vendored Dockerfile build via `runtime.ensureImage()`. The
//        substrate's content-addressed build cache short-circuits when
//        the (context + dockerfile + buildArgs) hash matches a prior result;
//        cold-cache wall-time is the upstream release download.
//
// Distilled-doc invariants honored:
//   - 24: `DEFAULT_SUI_VERSION` (the wrapper-baked sui binary) MUST
//        align with the localnet image's sui release.
//   - 25: ubuntu:24.04 base — handled in the Dockerfile.

import { Effect, type Scope } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../../contracts/container-runtime.ts';
import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';
import { walrusPluginError, type WalrusPluginError } from '../errors.ts';
import { DEFAULT_WALRUS_REF, DEFAULT_WALRUS_REPO } from './source-fetch.ts';

const WALRUS_CARGO_IMAGE_OVERRIDE_ENV = 'WALRUS_CARGO_IMAGE_OVERRIDE' as const;

/** Distilled-doc invariant 24: the wrapper-baked sui binary must
 *  match the localnet image's sui release. Pinned here in lockstep
 *  with the walrus ref bump. */
export const DEFAULT_SUI_VERSION = 'devnet-v1.71.0' as const;

/** Inputs to the walrus-image sibling — all knowable at factory
 *  time, hence type-level dedup is possible. */
export interface WalrusCargoImageInputs<Ref extends string = string, SuiV extends string = string> {
	readonly walrusRepo: typeof DEFAULT_WALRUS_REPO;
	readonly walrusRef: Ref;
	readonly suiVersion: SuiV;
}

/** Resolved value — the content-addressed image ref. */
export interface WalrusCargoImageResolved {
	readonly digest: string;
	readonly tag: string;
}

/** Compute the literal-typed sibling key. */
export const walrusCargoImageSiblingKey = <Ref extends string, SuiV extends string>(
	walrusRef: Ref,
	suiVersion: SuiV,
): LitSiblingKey<'walrus', 'cargo-image', 'per-process', `${Ref}|${SuiV}`> =>
	litSiblingKey('walrus', 'cargo-image', 'per-process', `${walrusRef}|${suiVersion}` as const);

/** Construct the sibling key for the default `(walrusRef, suiVersion)`. */
export const defaultWalrusCargoImageSiblingKey = () =>
	walrusCargoImageSiblingKey(DEFAULT_WALRUS_REF, DEFAULT_SUI_VERSION);

// ---------------------------------------------------------------------------
// Runtime resolver
// ---------------------------------------------------------------------------

/** Resolve to the on-disk path of the vendored Dockerfile context. */
const vendoredDockerfileContext = (): string =>
	new URL('../../../../images/walrus/', import.meta.url).pathname;

/** Resolve the walrus image. Path (a) trusts an env-override tag; path
 *  (b) builds the vendored Dockerfile via `runtime.ensureImage`. */
export const resolveCargoImage = (
	runtime: ContainerRuntime,
	inputs: WalrusCargoImageInputs,
): Effect.Effect<WalrusCargoImageResolved, WalrusPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const override = (globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env?.[WALRUS_CARGO_IMAGE_OVERRIDE_ENV];
		if (override && override.length > 0) {
			// Trust-the-tag path. The digest is opaque (substrate's
			// content-addressed cache will re-resolve via `docker inspect`
			// when it materializes the image).
			return { digest: override, tag: override };
		}

		// Real build via the vendored Dockerfile.
		const buildCtx = {
			contextPath: vendoredDockerfileContext(),
			dockerfile: 'Dockerfile',
			buildArgs: {
				WALRUS_VERSION: inputs.walrusRef,
				SUI_VERSION: inputs.suiVersion,
			},
		};

		const built = yield* runtime
			.ensureImage(buildCtx)
			.pipe(
				Effect.mapError((cause) =>
					walrusPluginError(
						'image-build',
						`walrus image build failed (walrusRef=${inputs.walrusRef}, suiVersion=${inputs.suiVersion}): ${cause.reason}: ${cause.detail}`,
						{ cause },
					),
				),
			);
		return { digest: built.digest, tag: built.tag ?? built.digest };
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.cargoImage.resolve', {
			attributes: {
				'walrus.ref': inputs.walrusRef,
				'walrus.suiVersion': inputs.suiVersion,
			},
		}),
	);

/** Convenience: resolve via the default inputs. */
export const resolveDefaultCargoImage = (
	runtime: ContainerRuntime,
): Effect.Effect<ImageRef, WalrusPluginError, Scope.Scope> =>
	resolveCargoImage(runtime, {
		walrusRepo: DEFAULT_WALRUS_REPO,
		walrusRef: DEFAULT_WALRUS_REF,
		suiVersion: DEFAULT_SUI_VERSION,
	});
