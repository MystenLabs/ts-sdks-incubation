// Multi-arch walrus-service image builder. Two-step Docker build:
//
//   1. Hybrid upstream image. The walrus release tarball ships
//      `walrus` + `walrus-node` as binaries; only `walrus-deploy`
//      (testbed bootstrap) is missing, so we curl the runtime
//      binaries and cargo-build only walrus-deploy. The Dockerfile
//      lives at `./upstream.Dockerfile` and source for the deploy
//      compile comes from a BuildKit named context (`walrus-src`).
//      Tagged `dev-examples/walrus-service:<release-slug>-upstream`.
//      First build is ~9–10 min on M-series; rev-bumps drop to ~1–2
//      min thanks to BuildKit cache mounts in the deploy-build stage.
//   2. Wrapper image at `./wrapper.Dockerfile` that composes on top:
//        - downloads the matching sui release tarball and bakes the
//          `sui` binary into `/root/sui_bin/sui`;
//        - copies our forked deploy.sh + run.sh into
//          /opt/walrus/scripts (replaces upstream's bash + the 5 sed
//          patches we used to layer on top).
//      Tagged `dev-examples/walrus-service:<release-slug>-sui<sui-ver>-<wrapper-rev>`.
//
// Native arm64 build on Apple Silicon — Rosetta is a 5–10x perf hit on
// release-profile Rust (CLAUDE.md, "avoid emulation").

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildImage, hostDockerPlatform, imageExists, pruneImagesByLabel } from '../sui/docker.js';
import { SUI_DEFAULT_VERSION } from '../sui/index.js';

/** Pinned walrus release tag. Doubles as a git ref (release tags
 * resolve to a commit) so BuildKit can fetch matching source for the
 * `walrus-deploy` compile stage from the same pin. Bump to upgrade the
 * local testbed.
 *
 * Tarball URL pattern:
 * `https://github.com/MystenLabs/walrus/releases/download/<tag>/walrus-<tag>-<platform>.tgz`
 * — same naming the sui-localnet image already follows. */
export const WALRUS_VERSION = 'devnet-v1.48.0';
const WALRUS_REPO = 'MystenLabs/walrus';

/** Rust toolchain version for the walrus-deploy compile stage. Matches
 * walrus's pinned `rust-toolchain.toml` at `WALRUS_VERSION` (typed-store
 * uses `Duration::from_mins` which was stabilized in 1.93 — older
 * toolchains fail with E0658). Bump in lockstep with the version pin.
 * Used as the `rust:<this>-bookworm` base — the bookworm variant
 * matches walrus's upstream Dockerfile, so the resulting binary links
 * against the same glibc as `debian:bookworm-slim` runtime. */
const WALRUS_RUST_TOOLCHAIN = '1.93';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPSTREAM_DOCKERFILE = resolve(HERE, 'upstream.Dockerfile');
const WRAPPER_DOCKERFILE = resolve(HERE, 'wrapper.Dockerfile');

/** Upstream-image revision suffix. Bumped when `upstream.Dockerfile`
 * changes in a way that doesn't already invalidate via `WALRUS_VERSION`
 * (e.g. swapping the runtime base, changing cargo flags, restructuring
 * stages). Carried in the tag so existing cached upstream images get
 * rebuilt on next `devstack up`.
 *
 * `r2`: switch runtime from `debian:bookworm-slim` (glibc 2.36) to
 *       `ubuntu:24.04` (glibc 2.38) so the wrapper's sui binary
 *       (built on Ubuntu 24.04) loads. `bookworm` failed with
 *       `version 'GLIBC_2.38' not found` once we tried to exec sui. */
const UPSTREAM_REV = 'r2';

/** Wrapper-image revision suffix. Bumped when the wrapper Dockerfile
 * (or the deploy.sh / run.sh scripts it copies) changes meaningfully,
 * so existing local images are rebuilt on next `devstack up`. Wrapper
 * tags also incorporate `UPSTREAM_REV` indirectly via the base image
 * digest — but for clarity we bump wrapper-rev whenever the upstream
 * rev changes too.
 *
 * `r2`: bake matching sui binary at /root/sui_bin/sui (replaces the
 * sui-bin shared-volume mechanism).
 * `r3`–`r7`: progressive sed patches on upstream's deploy/run scripts.
 * `r8`: hybrid build (binary fetch + walrus-deploy compile only).
 * `r9`: fork deploy.sh + run.sh in-tree, drop all sed patches; bump
 *       Dockerfile from inline strings to sibling files.
 * `r10`: run.sh now installs sui + walrus binaries on PATH (the
 *        previous fork accidentally dropped this from the upstream
 *        run-walrus.sh, breaking `sui client faucet` calls).
 * `r11`: upstream base bumped to ubuntu:24.04 (glibc 2.38) — wrapper
 *        bumped in lockstep so existing wrappers built against the
 *        bookworm base get rebuilt.
 * `r12`: run.sh writes /root/.config/walrus/client_config.yaml from
 *        the deploy file. Previous fork dropped this — `walrus get-wal`
 *        failed with "could not find a valid Walrus configuration
 *        file". */
const WRAPPER_REV = 'r12';

/** Slug a release tag into a tag-safe component (e.g. `devnet-v1.71.0`
 * → `devnet-v1-71-0`). Periods aren't allowed in docker tag suffixes
 * when combined with our format. */
function versionSlug(version: string): string {
	return version.replace(/\./g, '-');
}

export function walrusImageTag(
	version: string = WALRUS_VERSION,
	suiVersion: string = SUI_DEFAULT_VERSION,
): string {
	return `dev-examples/walrus-service:${versionSlug(version)}-sui${versionSlug(suiVersion)}-${WRAPPER_REV}`;
}

function walrusUpstreamImageTag(version: string): string {
	return `dev-examples/walrus-service:${versionSlug(version)}-upstream-${UPSTREAM_REV}`;
}

interface EnsureWalrusImageResult {
	imageTag: string;
	platform: string;
}

/** Idempotent: returns immediately when the runtime image is already
 * in the local Docker daemon. First build is ~9–10 min on M-series
 * (walrus-deploy depends on most of the walrus workspace); subsequent
 * version bumps drop to ~1–2 min thanks to BuildKit cache mounts in
 * the deploy-build stage.
 *
 * `appendLog` routes docker's combined stdout/stderr through the
 * supervisor's status renderer so build progress lines interleave
 * cleanly with the status block. Falls back to raw stderr when called
 * outside the supervisor (one-shot CLI paths). */
export async function ensureWalrusImage(opts: {
	version?: string;
	suiVersion?: string;
	appendLog?: (line: string) => void;
}): Promise<EnsureWalrusImageResult> {
	const version = opts.version ?? WALRUS_VERSION;
	const suiVersion = opts.suiVersion ?? SUI_DEFAULT_VERSION;
	const imageTag = walrusImageTag(version, suiVersion);
	const platform = hostDockerPlatform();
	const log = opts.appendLog ?? ((line: string) => process.stderr.write(`${line}\n`));

	if (await imageExists(imageTag)) {
		return { imageTag, platform };
	}

	const upstreamTag = walrusUpstreamImageTag(version);
	const gitContext = `https://github.com/${WALRUS_REPO}.git#${version}`;

	if (!(await imageExists(upstreamTag))) {
		log(
			`devstack walrus: building ${upstreamTag} (binary fetch + walrus-deploy compile, ${platform}) — first build ~9–10 min`,
		);
		await buildImage({
			tag: upstreamTag,
			contextDir: HERE,
			dockerfile: UPSTREAM_DOCKERFILE,
			platform,
			buildArgs: {
				WALRUS_TAG: version,
				RUST_TOOLCHAIN: WALRUS_RUST_TOOLCHAIN,
				// `walrus_utils::bin_version!` proc-macro reads
				// `env!("GIT_REVISION")` at compile time; without a
				// non-empty value it panics with E0080 ("unable to
				// query git revision"). The release tag is a stable,
				// human-readable identifier — embedding it as the
				// version string is what the upstream walrus Dockerfile
				// also does (it accepts `--build-arg GIT_REVISION=…`
				// from the caller's CI).
				GIT_REVISION: version,
			},
			buildContexts: { 'walrus-src': gitContext },
			labels: {
				'devstack.cache': 'walrus-upstream',
				'devstack.version': version,
			},
			appendLog: log,
		});
		// Drop superseded upstream tags (other walrus versions) — the
		// wrapper tag is on a different cache label so it survives.
		await pruneImagesByLabel({
			labels: { 'devstack.cache': 'walrus-upstream' },
			keep: [upstreamTag],
			appendLog: log,
		});
	}

	log(`devstack walrus: building ${imageTag} (wrapper + sui ${suiVersion})`);
	await buildImage({
		tag: imageTag,
		contextDir: HERE,
		dockerfile: WRAPPER_DOCKERFILE,
		platform,
		buildArgs: {
			BASE_IMAGE: upstreamTag,
			SUI_VERSION: suiVersion,
		},
		labels: {
			'devstack.cache': 'walrus-service',
			'devstack.version': version,
			'devstack.sui-version': suiVersion,
		},
		appendLog: log,
	});
	// Drop superseded wrapper tags (older WRAPPER_REV / sui-version
	// combinations for the same walrus version). Keyed on the wrapper
	// cache label so the upstream image (different label) is untouched.
	await pruneImagesByLabel({
		labels: { 'devstack.cache': 'walrus-service' },
		keep: [imageTag],
		appendLog: log,
	});

	return { imageTag, platform };
}
