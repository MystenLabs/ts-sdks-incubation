// Content-addressed source images for upstream Move packages.
//
// Replaces the host-clone caches at `packages/devstack-state/imports/<repo>@<rev>/`
// with Docker images named `dev-examples/upstream-source:<repo-slug>-<short-rev>`.
// Each image bakes the full git checkout under `/src` so import-time
// consumers (e.g. `helpers/imported-package.ts`) can `docker create` +
// `docker cp` the prepped sources to a tmp dir without touching the host
// filesystem outside the working app dir.
//
// The image has no runtime — it's a content-addressed blob. Content is
// keyed on `<repo, rev>` via the build args, so a rev bump produces a
// new image tag and Docker's layer cache short-circuits unchanged revs.
// Idempotent: returns immediately if the tag already exists locally.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerRun, imageExists } from '../plugins/sui/docker.js';

export interface EnsureUpstreamSourceImageOptions {
	repo: string;
	rev: string;
}

export interface EnsureUpstreamSourceImageResult {
	imageTag: string;
}

const DOCKERFILE = `# syntax=docker/dockerfile:1
ARG REPO
ARG REV
FROM alpine/git AS clone
ARG REPO
ARG REV
RUN git clone "https://github.com/\${REPO}.git" /src \\
	&& cd /src \\
	&& git checkout "\${REV}" \\
	&& rm -rf /src/.git
FROM scratch
COPY --from=clone /src /src
`;

export function upstreamSourceImageTag(repo: string, rev: string): string {
	const slug = repo.replace('/', '__');
	const shortRev = rev.length > 12 ? rev.slice(0, 12) : rev;
	return `dev-examples/upstream-source:${slug}-${shortRev}`;
}

export async function ensureUpstreamSourceImage(
	opts: EnsureUpstreamSourceImageOptions,
): Promise<EnsureUpstreamSourceImageResult> {
	const imageTag = upstreamSourceImageTag(opts.repo, opts.rev);
	if (await imageExists(imageTag)) {
		return { imageTag };
	}

	const tmpCtx = mkdtempSync(join(tmpdir(), 'devstack-upstream-src-'));
	try {
		writeFileSync(join(tmpCtx, 'Dockerfile'), DOCKERFILE);
		process.stderr.write(
			`devstack: building ${imageTag} (cloning ${opts.repo}@${opts.rev.slice(0, 12)})\n`,
		);
		const build = await dockerRun({
			command: [
				'build',
				'--tag',
				imageTag,
				'--build-arg',
				`REPO=${opts.repo}`,
				'--build-arg',
				`REV=${opts.rev}`,
				'--label',
				'devstack.cache=upstream-source',
				'--label',
				`devstack.repo=${opts.repo}`,
				'--label',
				`devstack.rev=${opts.rev}`,
				tmpCtx,
			],
			stream: true,
		});
		if (build.code !== 0) {
			throw new Error(`devstack upstream-source: build failed (exit ${build.code})`);
		}
	} finally {
		rmSync(tmpCtx, { recursive: true, force: true });
	}

	return { imageTag };
}

/**
 * Extract `/src` (or a subpath) from an upstream-source image into
 * `destDir` on the host. Uses `docker create` + `docker cp` + `docker rm`
 * since `docker run --rm` against a `FROM scratch` image has no entrypoint.
 *
 * The created container is never started; we only need its filesystem
 * layers so `docker cp` can read them. Docker still requires *some*
 * command to be specified though, even on FROM scratch images — we pass
 * `[/_devstack_noop]` as a deliberately-nonexistent path. Same shape works
 * against any image (including the seal image) where we want the layer
 * contents but never plan to run the entrypoint.
 *
 * Returns nothing on success; throws on any docker failure (caller is
 * responsible for cleaning up `destDir`).
 */
export async function extractUpstreamSource(opts: {
	imageTag: string;
	/** Path inside the image to copy; defaults to `/src`. */
	srcPath?: string;
	/** Host directory to copy *into*. Must already exist. The contents
	 * of `srcPath` (not the dir itself) end up directly under `destDir`. */
	destDir: string;
}): Promise<void> {
	const srcPath = opts.srcPath ?? '/src';
	const create = await dockerRun({
		command: ['create', '--entrypoint', '/_devstack_noop', opts.imageTag],
	});
	if (create.code !== 0) {
		throw new Error(`devstack upstream-source: docker create failed: ${create.stderr.trim()}`);
	}
	const containerId = create.stdout.trim();
	try {
		const cp = await dockerRun({
			command: ['cp', `${containerId}:${srcPath}/.`, opts.destDir],
		});
		if (cp.code !== 0) {
			throw new Error(`devstack upstream-source: docker cp failed: ${cp.stderr.trim()}`);
		}
	} finally {
		await dockerRun({ command: ['rm', '-f', containerId] }).catch(() => undefined);
	}
}
