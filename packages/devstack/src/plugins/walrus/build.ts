// Multi-arch walrus-service image builder. Two-step Docker build with no
// host filesystem state:
//
//   1. Build the upstream `walrus-service` target directly from the
//      walrus repo's git URL as a BuildKit context — Docker fetches the
//      pinned rev itself, runs the upstream Dockerfile, caches by layer.
//      Tagged `dev-examples/walrus-service:<short-rev>-upstream`.
//   2. Build a tiny wrapper from `plugins/walrus/Dockerfile` that layers
//      `docker/local-testbed/files/{deploy,run}-walrus.sh` onto the
//      upstream image, sourcing those scripts from the same git URL via
//      a BuildKit `--build-context walrus-src=<git-url>#<rev>`. Tagged
//      `dev-examples/walrus-service:<short-rev>` (the runtime image).
//
// Scripts now ship inside the image at `/opt/walrus/scripts/`, so the
// walrus runtime no longer mounts them from a host clone.
//
// Native arm64 build on Apple Silicon — Rosetta is a 5–10x perf hit on
// release-profile Rust (CLAUDE.md, "avoid emulation").

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerRun, imageExists } from '../sui/docker.js';

/** Pinned walrus revision. Picked from the most recent walrus_v1.48.0
 * release as of pinning. Bump WALRUS_REV to upgrade the local testbed. */
export const WALRUS_REV = '76254d1d4eb7a75ee22d9022e5229d3f757c6990';
export const WALRUS_REPO = 'MystenLabs/walrus';

// Dockerfile content baked in as a string. The wrapper layers two
// upstream walrus scripts (deploy-walrus.sh / run-walrus.sh) onto the
// upstream image, then patches the deploy script to also create a WAL
// exchange object — without `--with-wal-exchange`, browser apps can't
// get the WAL needed to pay for blob storage.
//
// We can't ship a separate `Dockerfile` file because the package only
// publishes `dist/` and tsup doesn't copy non-source assets; embedding
// as a string keeps things self-contained.
const WRAPPER_DOCKERFILE_CONTENT = `# syntax=docker/dockerfile:1
ARG BASE_IMAGE
FROM \${BASE_IMAGE} AS final
COPY --from=walrus-src docker/local-testbed/files/deploy-walrus.sh /opt/walrus/scripts/deploy-walrus.sh
COPY --from=walrus-src docker/local-testbed/files/run-walrus.sh /opt/walrus/scripts/run-walrus.sh
RUN sed -i 's|--storage-price 5|--with-wal-exchange --storage-price 5|' /opt/walrus/scripts/deploy-walrus.sh
RUN chmod +x /opt/walrus/scripts/*.sh
`;

/** Wrapper-image revision suffix. Bumped when the wrapper `Dockerfile`
 * changes (e.g. injecting a new `walrus-deploy` flag) so existing local
 * images are rebuilt on next `devstack up`. The upstream walrus build
 * stays cached because its tag (`<rev>-upstream`) doesn't carry the
 * suffix — only the wrapper rebuild runs. */
const WRAPPER_REV = 'r1';

export function walrusImageTag(rev: string = WALRUS_REV): string {
	return `dev-examples/walrus-service:${rev.slice(0, 12)}-${WRAPPER_REV}`;
}

function walrusUpstreamImageTag(rev: string): string {
	return `dev-examples/walrus-service:${rev.slice(0, 12)}-upstream`;
}

export function hostDockerArch(): 'arm64' | 'amd64' {
	const arch = process.arch;
	if (arch === 'arm64') return 'arm64';
	if (arch === 'x64') return 'amd64';
	throw new Error(`devstack walrus: unsupported host architecture ${arch}`);
}

export function hostDockerPlatform(): string {
	return `linux/${hostDockerArch()}`;
}

export interface EnsureWalrusImageResult {
	imageTag: string;
	platform: string;
}

/** Idempotent: returns immediately when the runtime image is already in
 * the local Docker daemon. First build is slow (~10 min on M-series; the
 * Rust build dominates) so we surface that to the developer. */
export async function ensureWalrusImage(opts: { rev?: string }): Promise<EnsureWalrusImageResult> {
	const rev = opts.rev ?? WALRUS_REV;
	const imageTag = walrusImageTag(rev);
	const platform = hostDockerPlatform();

	if (await imageExists(imageTag)) {
		return { imageTag, platform };
	}

	const upstreamTag = walrusUpstreamImageTag(rev);
	const gitContext = `https://github.com/${WALRUS_REPO}.git#${rev}`;

	if (!(await imageExists(upstreamTag))) {
		process.stderr.write(
			`devstack walrus: building ${upstreamTag} from ${WALRUS_REPO}@${rev.slice(0, 12)} (${platform}) — first build ~10 min\n`,
		);
		const upstream = await dockerRun({
			command: [
				'build',
				'--tag',
				upstreamTag,
				'--file',
				'docker/walrus-service/Dockerfile',
				'--target',
				'walrus-service',
				'--platform',
				platform,
				'--label',
				'devstack.cache=walrus-upstream',
				'--label',
				`devstack.rev=${rev}`,
				gitContext,
			],
			stream: true,
		});
		if (upstream.code !== 0) {
			throw new Error(`devstack walrus: upstream build failed (exit ${upstream.code})`);
		}
	}

	process.stderr.write(`devstack walrus: building ${imageTag} (wrapper with bootstrap scripts)\n`);
	// Materialize the inlined Dockerfile to a fresh tmp dir per build so
	// the build context exists on disk (docker BuildKit needs a context
	// path) but no source-tree assumptions are made about where the file
	// lives. The dir is short-lived: docker reads the Dockerfile, the
	// wrapper layers come from BuildKit contexts, and the dir is gone
	// after process exit.
	const tmpContextDir = mkdtempSync(join(tmpdir(), 'devstack-walrus-build-'));
	const dockerfilePath = join(tmpContextDir, 'Dockerfile');
	writeFileSync(dockerfilePath, WRAPPER_DOCKERFILE_CONTENT, 'utf8');
	const wrapper = await dockerRun({
		command: [
			'build',
			'--tag',
			imageTag,
			'--file',
			dockerfilePath,
			'--platform',
			platform,
			'--build-arg',
			`BASE_IMAGE=${upstreamTag}`,
			'--build-context',
			`walrus-src=${gitContext}`,
			'--label',
			'devstack.cache=walrus-service',
			'--label',
			`devstack.rev=${rev}`,
			tmpContextDir,
		],
		stream: true,
	});
	if (wrapper.code !== 0) {
		throw new Error(`devstack walrus: wrapper build failed (exit ${wrapper.code})`);
	}

	return { imageTag, platform };
}
