// Multi-arch walrus-service image builder. Two-step Docker build with no
// host filesystem state:
//
//   1. Build the upstream `walrus-service` target directly from the
//      walrus repo's git URL as a BuildKit context — Docker fetches the
//      pinned rev itself, runs the upstream Dockerfile, caches by layer.
//      Tagged `dev-examples/walrus-service:<short-rev>-upstream`.
//   2. Build a wrapper that:
//        - downloads a matching sui release tarball and bakes the `sui`
//          binary into `/root/sui_bin/sui` — replacing the prior
//          `sui-bin` shared-volume mechanism, so storage nodes no longer
//          depend on the sui container's volume export at runtime;
//        - layers `docker/local-testbed/files/{deploy,run}-walrus.sh`
//          onto the image (sourced via BuildKit
//          `--build-context walrus-src=<git-url>#<rev>`);
//        - patches the deploy script to also create a WAL exchange
//          object (`--with-wal-exchange`).
//      Tagged `dev-examples/walrus-service:<short-rev>-sui<sui-ver>-<wrapper-rev>`.
//
// Native arm64 build on Apple Silicon — Rosetta is a 5–10x perf hit on
// release-profile Rust (CLAUDE.md, "avoid emulation").

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerRun, imageExists } from '../sui/docker.js';
import { SUI_DEFAULT_VERSION } from '../sui/index.js';

/** Pinned walrus revision. Picked from the most recent walrus_v1.48.0
 * release as of pinning. Bump WALRUS_REV to upgrade the local testbed. */
export const WALRUS_REV = '76254d1d4eb7a75ee22d9022e5229d3f757c6990';
export const WALRUS_REPO = 'MystenLabs/walrus';

// Dockerfile content baked in as a string. Two stages:
//
//   sui-fetch: downloads the sui release tarball matching SUI_VERSION
//              (multi-arch) and extracts `sui` to /sui-bin/sui.
//   final:     starts from the upstream walrus-service base, copies in
//              the sui binary at /root/sui_bin/sui (the path the
//              testbed scripts expect), and overlays the deploy/run
//              scripts patched to enable WAL exchange.
//
// We can't ship a separate `Dockerfile` file because the package only
// publishes `dist/` and tsup doesn't copy non-source assets; embedding
// as a string keeps things self-contained.
const WRAPPER_DOCKERFILE_CONTENT = `# syntax=docker/dockerfile:1
ARG BASE_IMAGE
ARG SUI_VERSION
ARG TARGETARCH

FROM ubuntu:24.04 AS sui-fetch
ARG SUI_VERSION
ARG TARGETARCH
RUN apt-get update \\
	&& apt-get install -y --no-install-recommends ca-certificates curl \\
	&& rm -rf /var/lib/apt/lists/*
RUN set -eux; \\
	case "$TARGETARCH" in \\
		arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \\
		amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \\
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \\
	esac; \\
	url="https://github.com/MystenLabs/sui/releases/download/\${SUI_VERSION}/sui-\${SUI_VERSION}-\${SUI_PLATFORM}.tgz"; \\
	curl -fsSL "$url" -o /tmp/sui.tgz; \\
	mkdir -p /tmp/sui-unpack /sui-bin; \\
	tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \\
	find /tmp/sui-unpack -maxdepth 2 -type f -executable -name sui -exec mv {} /sui-bin/sui \\; ; \\
	chmod +x /sui-bin/sui; \\
	rm -rf /tmp/sui.tgz /tmp/sui-unpack

FROM \${BASE_IMAGE} AS final
RUN mkdir -p /root/sui_bin
COPY --from=sui-fetch /sui-bin/sui /root/sui_bin/sui
RUN chmod +x /root/sui_bin/sui
COPY --from=walrus-src docker/local-testbed/files/deploy-walrus.sh /opt/walrus/scripts/deploy-walrus.sh
COPY --from=walrus-src docker/local-testbed/files/run-walrus.sh /opt/walrus/scripts/run-walrus.sh
RUN sed -i 's|--storage-price 5|--with-wal-exchange --storage-price 5|' /opt/walrus/scripts/deploy-walrus.sh
# Replace the hardcoded host addresses with a runtime env var so the
# walrus.deploy action can pass per-stack IPs (10.<octet>.0.10–13). The
# unquoted \${WALRUS_NODE_IPS} preserves bash word-splitting so the four
# IPs land as four separate arguments to --host-addresses.
RUN sed -i 's|--host-addresses 10\\.0\\.0\\.10 10\\.0\\.0\\.11 10\\.0\\.0\\.12 10\\.0\\.0\\.13|--host-addresses \${WALRUS_NODE_IPS}|' /opt/walrus/scripts/deploy-walrus.sh
# Redirect storage_path in each generated YAML config from the bind-
# mounted (read-only) outputs dir to /var/walrus/storage in the
# container's writable layer. Matches the no-volumes architectural
# intent — configs live under \`<stackDir>\` (host capture); RocksDB
# state lives in the writable layer (captured via docker commit on
# snapshot save). The append runs after generate-dry-run-configs.
RUN echo 'for f in /opt/walrus/outputs/dryrun-node-*.yaml; do sed -i "s|^storage_path: /opt/walrus/outputs/|storage_path: /var/walrus/storage/|" "$f"; done' >> /opt/walrus/scripts/deploy-walrus.sh
# Ensure the storage path exists in node containers' writable layer.
RUN mkdir -p /var/walrus/storage
RUN chmod +x /opt/walrus/scripts/*.sh
`;

/** Wrapper-image revision suffix. Bumped when the wrapper `Dockerfile`
 * changes (e.g. injecting a new `walrus-deploy` flag, adding the baked
 * sui binary) so existing local images are rebuilt on next `devstack
 * up`. The upstream walrus build stays cached because its tag
 * (`<rev>-upstream`) doesn't carry the suffix — only the wrapper
 * rebuild runs.
 *
 * `r2`: bake matching sui binary at /root/sui_bin/sui (replaces the
 * sui-bin shared-volume mechanism). The wrapper image now encodes both
 * the walrus rev AND the sui version in its tag.
 * `r3`: replace the hardcoded `--host-addresses 10.0.0.10 10.0.0.11
 * 10.0.0.12 10.0.0.13` in the deploy script with `${WALRUS_NODE_IPS}`
 * so the walrus.deploy action can pass per-stack IPs through env
 * (unblocks parallel walrus stacks). Also redirect each per-node
 * YAML's `storage_path` from the read-only bind-mounted outputs dir
 * to `/var/walrus/storage` in the container's writable layer
 * (`docker commit` captures it on snapshot save), matching the
 * no-volumes architectural intent for storage-node RocksDB. */
const WRAPPER_REV = 'r3';

/** Slug a sui version into a tag-safe component (e.g. `devnet-v1.71.0` →
 * `devnet-v1-71-0`). Periods aren't allowed in docker tag suffixes when
 * combined with our format. */
function suiVersionSlug(version: string): string {
	return version.replace(/\./g, '-');
}

export function walrusImageTag(
	rev: string = WALRUS_REV,
	suiVersion: string = SUI_DEFAULT_VERSION,
): string {
	return `dev-examples/walrus-service:${rev.slice(0, 12)}-sui${suiVersionSlug(suiVersion)}-${WRAPPER_REV}`;
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
 * Rust build dominates) so we surface that to the developer. The
 * wrapper rebuild adds ~30 s for the sui-fetch stage on cache miss. */
export async function ensureWalrusImage(opts: {
	rev?: string;
	suiVersion?: string;
}): Promise<EnsureWalrusImageResult> {
	const rev = opts.rev ?? WALRUS_REV;
	const suiVersion = opts.suiVersion ?? SUI_DEFAULT_VERSION;
	const imageTag = walrusImageTag(rev, suiVersion);
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

	process.stderr.write(
		`devstack walrus: building ${imageTag} (wrapper + sui ${suiVersion})\n`,
	);
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
			'--build-arg',
			`SUI_VERSION=${suiVersion}`,
			'--build-context',
			`walrus-src=${gitContext}`,
			'--label',
			'devstack.cache=walrus-service',
			'--label',
			`devstack.rev=${rev}`,
			'--label',
			`devstack.sui-version=${suiVersion}`,
			tmpContextDir,
		],
		stream: true,
	});
	if (wrapper.code !== 0) {
		throw new Error(`devstack walrus: wrapper build failed (exit ${wrapper.code})`);
	}

	return { imageTag, platform };
}
