// Multi-arch seal image builder. Pulls the published `seal-cli` and
// `key-server` binaries from the seal GitHub release — no cargo compile.
// The `move/seal` Move package is staged at /opt/seal/move-package via
// `--build-context seal-src=https://github.com/MystenLabs/seal.git#<tag>`
// so `seal.publish` can extract it at publish time.
//
// Native arm64 build on Apple Silicon — the released binary is a
// linux/arm64 ELF, so the resulting image runs natively under Docker
// Desktop's vmm without Rosetta.
//
// `HERE` and `SEAL_DOCKERFILE` resolve via `new URL(...).pathname` —
// browser-safe equivalent of `dirname(fileURLToPath(import.meta.url))` —
// so this module's static surface stays clean of `node:path` /
// `node:url` named imports for `examples/*` Vite builds (the main-
// barrel chain reaches `seal.build` transitively).

import {
	DEVSTACK_IMAGE_NAMESPACE,
	hostDockerPlatform,
	imageExists,
	pruneImagesByLabel,
} from '../../runtime/docker/index.js';
import { dockerRun } from '../../runtime/docker/run.js';

/** Pinned seal release tag. Doubles as a git ref so BuildKit can pull
 * the matching `move/seal` Move package source via the `seal-src`
 * named build-context. Bump to upgrade the local key-server.
 *
 * Release artifact URL pattern:
 *   https://github.com/MystenLabs/seal/releases/download/<tag>/seal-<platform>
 *   https://github.com/MystenLabs/seal/releases/download/<tag>/key-server-<platform>
 *
 * The seal release workflow renames `seal-cli` → `seal-${platform}` for
 * the release; the Dockerfile renames it back inside the image so the
 * plugin's `--entrypoint seal-cli` invocation works unchanged. */
export const SEAL_VERSION = 'seal-v0.6.6';
const SEAL_REPO = 'MystenLabs/seal';
/** TS SDK version the upstream key-server's version-validation middleware
 * compares against (sent in the `Client-Sdk-Version` header from the
 * container's healthcheck). Must satisfy the key-server's
 * `ts_sdk_version_requirement` field — bump in lockstep with SEAL_VERSION. */
export const SEAL_SDK_VERSION = '0.4.18';

const HERE = new URL('.', import.meta.url).pathname;
const SEAL_DOCKERFILE = `${HERE}Dockerfile`;

/** Slug a release tag into a tag-safe component (e.g. `seal-v0.6.6` →
 * `seal-v0-6-6`). Periods aren't allowed in docker tag suffixes when
 * combined with our format. */
function versionSlug(version: string): string {
	return version.replace(/\./g, '-');
}

export function sealImageTag(version: string = SEAL_VERSION): string {
	return `${DEVSTACK_IMAGE_NAMESPACE}/seal:${versionSlug(version)}`;
}

/** Path to the Move package inside the built seal image. `seal.publish`
 * extracts this to a host tmp dir and feeds it to `publishMovePackage`. */
export const SEAL_IMAGE_MOVE_PACKAGE_PATH = '/opt/seal/move-package';

interface EnsureSealImageResult {
	imageTag: string;
	platform: string;
}

/** Idempotent: returns immediately when the image is already in the local
 * Docker daemon. First build is ~30 s — just two binary downloads + a
 * tiny Move-package COPY. The previous Rust-from-source build took
 * ~5–8 min on M-series, replaced once seal published `seal-cli` and
 * `key-server` as release artifacts.
 *
 * `appendLog` routes docker's combined stdout/stderr through the
 * supervisor's status renderer; falls back to raw stderr when called
 * outside the supervisor. */
export async function ensureSealImage(opts: {
	version?: string;
	appendLog?: (line: string) => void;
}): Promise<EnsureSealImageResult> {
	const version = opts.version ?? SEAL_VERSION;
	const imageTag = sealImageTag(version);
	const platform = hostDockerPlatform();
	const log = opts.appendLog ?? ((line: string) => process.stderr.write(`${line}\n`));

	if (await imageExists(imageTag)) {
		return { imageTag, platform };
	}

	const gitContext = `https://github.com/${SEAL_REPO}.git#${version}`;
	log(`devstack seal: building ${imageTag} (binary fetch, ${platform}) — first build ~30 s`);
	const build = await dockerRun({
		command: [
			'build',
			'--tag',
			imageTag,
			'--file',
			SEAL_DOCKERFILE,
			'--platform',
			platform,
			'--build-arg',
			`SEAL_TAG=${version}`,
			'--build-context',
			`seal-src=${gitContext}`,
			'--label',
			'devstack.cache=seal',
			'--label',
			`devstack.version=${version}`,
			HERE,
		],
		stream: true,
		appendLog: log,
	});
	if (build.code !== 0) {
		throw new Error(`devstack seal: docker build failed (exit ${build.code})`);
	}
	// Drop superseded seal tags (older SEAL_VERSIONs). Keyed on the seal
	// cache label so unrelated images are untouched.
	await pruneImagesByLabel({
		labels: { 'devstack.cache': 'seal' },
		keep: [imageTag],
		appendLog: log,
	});

	return { imageTag, platform };
}
