// Multi-arch seal image builder. Single-step Docker build with no host
// filesystem state: BuildKit fetches the seal repo at the pinned rev
// directly via a named build-context (`seal-src`), and the Dockerfile
// `COPY --from=seal-src …` pulls source files into the build. Both
// `key-server` and `seal-cli` end up in the runtime image, plus the
// `move/seal` Move package staged at `/opt/seal/move-package` for
// `seal.publish` to extract at publish time.
//
// Native arm64 build on Apple Silicon — Rosetta is a 5–10x perf hit on a
// release-profile Rust build (CLAUDE.md, "avoid emulation").

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerRun, imageExists } from '../sui/docker.js';

/** Pinned seal revision. Matches the latest tagged seal release as of
 * pinning (https://github.com/MystenLabs/seal/releases/tag/seal-v0.6.5).
 * Bump SEAL_REV to upgrade the local key-server. */
export const SEAL_REV = '1caeaaa1ec8f48b2635d317c752b7e316f6be416';
export const SEAL_REPO = 'MystenLabs/seal';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL_DOCKERFILE = resolve(HERE, 'Dockerfile');

export function sealImageTag(rev: string = SEAL_REV): string {
	return `dev-examples/seal:${rev.slice(0, 12)}`;
}

/** Path to the Move package inside the built seal image. `seal.publish`
 * extracts this to a host tmp dir and feeds it to `publishMovePackage`. */
export const SEAL_IMAGE_MOVE_PACKAGE_PATH = '/opt/seal/move-package';

export function hostDockerArch(): 'arm64' | 'amd64' {
	const arch = process.arch;
	if (arch === 'arm64') return 'arm64';
	if (arch === 'x64') return 'amd64';
	throw new Error(`devstack seal: unsupported host architecture ${arch}`);
}

export function hostDockerPlatform(): string {
	return `linux/${hostDockerArch()}`;
}

export interface EnsureSealImageResult {
	imageTag: string;
	platform: string;
}

/** Idempotent: returns immediately when the image is already in the local
 * Docker daemon. First build is multi-minute Rust release (~5–8 min on
 * M-series); we surface that to the developer via stderr. */
export async function ensureSealImage(opts: { rev?: string }): Promise<EnsureSealImageResult> {
	const rev = opts.rev ?? SEAL_REV;
	const imageTag = sealImageTag(rev);
	const platform = hostDockerPlatform();

	if (await imageExists(imageTag)) {
		return { imageTag, platform };
	}

	const gitContext = `https://github.com/${SEAL_REPO}.git#${rev}`;
	process.stderr.write(
		`devstack seal: building ${imageTag} from ${SEAL_REPO}@${rev.slice(0, 12)} (${platform}) — first build ~5–8 min\n`,
	);
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
			`GIT_REVISION=${rev.slice(0, 12)}`,
			'--build-context',
			`seal-src=${gitContext}`,
			'--label',
			'devstack.cache=seal',
			'--label',
			`devstack.rev=${rev}`,
			HERE,
		],
		stream: true,
	});
	if (build.code !== 0) {
		throw new Error(`devstack seal: docker build failed (exit ${build.code})`);
	}

	return { imageTag, platform };
}
