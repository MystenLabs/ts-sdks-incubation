// Content-addressed source images for upstream Move packages.
//
// Replaces the host-clone caches at `packages/devstack-state/imports/<repo>@<rev>/`
// with Docker images named `mysten-devstack/upstream-source:<repo-slug>-<short-rev>`.
// Each image bakes the full git checkout under `/src` so import-time
// consumers (e.g. `helpers/imported-package.ts`) can `docker create` +
// `docker cp` the prepped sources to a tmp dir without touching the host
// filesystem outside the working app dir.
//
// The image has no runtime — it's a content-addressed blob. Content is
// keyed on `<repo, rev>` via the build args, so a rev bump produces a
// new image tag and Docker's layer cache short-circuits unchanged revs.
// Idempotent: returns immediately if the tag already exists locally.
//
// `node:*` modules load via top-level `await import(...)` so the static
// surface stays browser-safe — see `runtime/hash.ts` for rationale.

import { imageExists, pruneImagesByLabel } from '../runtime/docker/images.js';
import { DEVSTACK_IMAGE_NAMESPACE } from '../runtime/docker/labels.js';
import { dockerRun } from '../runtime/docker/run.js';

const [nodeFs, nodeOs, nodePath] = await Promise.all([
	import('node:fs'),
	import('node:os'),
	import('node:path'),
]);

interface EnsureUpstreamSourceImageOptions {
	repo: string;
	rev: string;
	/** Override the git host URL template. Default builds
	 * `https://github.com/<repo>.git`. Pass an explicit URL (e.g.
	 * `https://gitlab.example.com/owner/repo.git`) when the upstream
	 * isn't on GitHub. The `<repo>` token is replaced verbatim.
	 *
	 * Pass a function `(repo, rev) => url` for full programmatic control
	 * (private hosts that mint short-lived clone URLs, etc.). */
	gitUrl?: string | ((repo: string, rev: string) => string);
	/** Route docker's combined stdout/stderr through the supervisor's
	 * status renderer when called from inside `devstack up`. Falls back
	 * to raw stderr when undefined (one-shot CLI paths). */
	appendLog?: (line: string) => void;
}

interface EnsureUpstreamSourceImageResult {
	imageTag: string;
}

function resolveGitUrl(
	repo: string,
	rev: string,
	override: EnsureUpstreamSourceImageOptions['gitUrl'],
): string {
	if (typeof override === 'function') return override(repo, rev);
	if (typeof override === 'string') return override.replace('<repo>', repo);
	return `https://github.com/${repo}.git`;
}

function makeDockerfile(gitUrl: string): string {
	return `# syntax=docker/dockerfile:1
ARG REV
FROM alpine/git AS clone
ARG REV
RUN git clone "${gitUrl}" /src \\
	&& cd /src \\
	&& git checkout "\${REV}" \\
	&& rm -rf /src/.git
FROM scratch
COPY --from=clone /src /src
`;
}

export function upstreamSourceImageTag(repo: string, rev: string): string {
	const slug = repo.replace('/', '__');
	const shortRev = rev.length > 12 ? rev.slice(0, 12) : rev;
	return `${DEVSTACK_IMAGE_NAMESPACE}/upstream-source:${slug}-${shortRev}`;
}

export async function ensureUpstreamSourceImage(
	opts: EnsureUpstreamSourceImageOptions,
): Promise<EnsureUpstreamSourceImageResult> {
	const imageTag = upstreamSourceImageTag(opts.repo, opts.rev);
	if (await imageExists(imageTag)) {
		return { imageTag };
	}

	const gitUrl = resolveGitUrl(opts.repo, opts.rev, opts.gitUrl);
	const tmpCtx = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'devstack-upstream-src-'));
	const log = opts.appendLog ?? ((line: string) => process.stderr.write(`${line}\n`));
	try {
		nodeFs.writeFileSync(nodePath.join(tmpCtx, 'Dockerfile'), makeDockerfile(gitUrl));
		log(`devstack: building ${imageTag} (cloning ${gitUrl} @ ${opts.rev.slice(0, 12)})`);
		const build = await dockerRun({
			command: [
				'build',
				'--tag',
				imageTag,
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
			appendLog: log,
		});
		if (build.code !== 0) {
			throw new Error(`devstack upstream-source: build failed (exit ${build.code})`);
		}
		// Drop superseded revs *of this repo* (other repos' images keep
		// their own tags — the `devstack.repo` filter scopes the prune).
		await pruneImagesByLabel({
			labels: { 'devstack.cache': 'upstream-source', 'devstack.repo': opts.repo },
			keep: [imageTag],
			appendLog: log,
		});
	} finally {
		nodeFs.rmSync(tmpCtx, { recursive: true, force: true });
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
