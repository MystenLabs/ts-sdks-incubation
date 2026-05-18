// Image-layer docker wrappers — `pull`, `build`, `saveImage`, `loadImage`.
// Each shells out via the shared `runCapturingOrFail` helper so the
// error envelope (truncated stdout/stderr in `DockerError.message`)
// matches the rest of the slice.

import { isAbsolute, resolve } from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { DockerError } from '../../engine/errors.js';
import { runCapturingOrFail } from './core.js';

// -----------------------------------------------------------------------------
// Pull — ensure image present, return digest
// -----------------------------------------------------------------------------

export interface DockerPullResult {
	readonly digest: string;
}

export const pull = (
	image: string,
): Effect.Effect<DockerPullResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.image': image });

		yield* runCapturingOrFail(spawner, ChildProcess.make('docker', ['pull', image]), 'docker pull');

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', image]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					phase: 'docker pull',
					message: `docker image inspect returned empty digest for ${image}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.pull'));

// -----------------------------------------------------------------------------
// imageExists — best-effort "is this tag known to the daemon?"
//
// Returns `{ digest }` if the tag is present, undefined otherwise.
// Used by `dockerImage({build})` to short-circuit the build when a
// content-addressed tag is already on disk — without this, `docker build`
// runs unconditionally and (even though layer-cached) re-tags the image
// to the freshly-built content. That re-tag destroys snapshot.restore's
// `docker tag <snap> <originalImage>` step, dropping snapshot chain
// state back to a fresh-genesis world.
// -----------------------------------------------------------------------------

export const imageExists = (
	tag: string,
): Effect.Effect<{ digest: string } | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const cmd = ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', tag]);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const digest = out.trim();
		return digest.length === 0 ? undefined : { digest };
	}).pipe(Effect.withSpan('Docker.imageExists'));

// -----------------------------------------------------------------------------
// Build — build an image from a local context, return tag + digest
// -----------------------------------------------------------------------------

export interface DockerBuildOptions {
	readonly context: string;
	readonly dockerfile?: string;
	readonly buildArgs?: Record<string, string>;
	readonly platform?: string;
	readonly tag: string;
}

export interface DockerBuildResult {
	readonly tag: string;
	readonly digest: string;
}

export const build = (
	opts: DockerBuildOptions,
): Effect.Effect<DockerBuildResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'build', 'docker.tag': opts.tag });

		const args: Array<string> = ['build', '--tag', opts.tag];
		// Global devstack-built marker. `prune --include-images` and the
		// inventory query both filter on `label=devstack.image=true` —
		// keeping the label here (the only place we shell out to
		// `docker build`) means every image we produce is reachable to
		// the cleanup tooling. Per-stack `devstack.app` / `devstack.stack`
		// labels are NOT stamped on images: a single built image (e.g.
		// `walrus-rs:dev`) is intentionally reused across stacks.
		args.push('--label', 'devstack.image=true');
		if (opts.platform !== undefined) args.push('--platform', opts.platform);
		for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
			args.push('--build-arg', `${k}=${v}`);
		}
		// Resolve `dockerfile` to an absolute path. BuildKit (the default
		// builder on modern Docker Desktop) looks `-f <path>` up relative
		// to the CLI's CWD, not the build context — passing the bare name
		// `'Dockerfile'` from a CWD that doesn't contain one fails with
		// `failed to read dockerfile: open Dockerfile: no such file or
		// directory` even though the file lives inside `context`. v3's
		// runner did the same resolve; we mirror it here.
		if (opts.dockerfile !== undefined) {
			const dfAbs = isAbsolute(opts.dockerfile)
				? opts.dockerfile
				: resolve(opts.context, opts.dockerfile);
			args.push('-f', dfAbs);
		}
		args.push(opts.context);

		yield* runCapturingOrFail(spawner, ChildProcess.make('docker', args), 'docker build');

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', opts.tag]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					phase: 'docker build',
					message: `docker image inspect returned empty digest for ${opts.tag}`,
				}),
			);
		}
		return { tag: opts.tag, digest };
	}).pipe(Effect.withSpan('Docker.build'));

// -----------------------------------------------------------------------------
// saveImage — serialize an image to a tar on disk
// -----------------------------------------------------------------------------

// `docker save <image> -o <tar>` writes the image (including all layers) to a
// portable tar archive. Used by snapshot to persist committed container state.
export const saveImage = (
	imageName: string,
	tarPath: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'save',
			'docker.image': imageName,
			'docker.tarPath': tarPath,
		});

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['save', imageName, '-o', tarPath]),
			'docker save',
		);
	}).pipe(Effect.withSpan('Docker.saveImage'));

// -----------------------------------------------------------------------------
// loadImage — reverse of saveImage; restore image from tar
// -----------------------------------------------------------------------------

export interface DockerLoadResult {
	readonly tag: string;
}

// `docker load -i <tar>` writes the image back into the local daemon and
// prints e.g. `Loaded image: devstack-snap:abc-foo`. We parse the tag out of
// that line so the caller can re-run a container off it. If the daemon emits
// a digest-only message (no tag) the load still succeeds but we surface a
// typed error — callers always want a tag they can pass to `docker run`.
export const loadImage = (
	tarPath: string,
): Effect.Effect<DockerLoadResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'load', 'docker.tarPath': tarPath });

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['load', '-i', tarPath]),
			'docker load',
		);

		// Output looks like `Loaded image: devstack-snap:abc-foo` (possibly
		// across multiple lines if the tar carries several images — take the
		// first matching tag line).
		const match = stdout
			.split('\n')
			.map((line) => line.trim())
			.map((line) => /^Loaded image(?: ID)?:\s*(.+)$/.exec(line))
			.find((m): m is RegExpExecArray => m !== null);

		if (!match) {
			return yield* Effect.fail(
				new DockerError({
					phase: 'docker load',
					message: `docker load produced no "Loaded image:" line for ${tarPath}`,
					stdout,
				}),
			);
		}
		return { tag: match[1] };
	}).pipe(Effect.withSpan('Docker.loadImage'));

// -----------------------------------------------------------------------------
// tagImage — alias an existing image under a new tag.
//
// Used by `snapshot.restore` so a `docker load`-ed snapshot image
// (named `devstack-snap:<id>-<name>`) ALSO carries the supervisor's
// expected content-addressed base tag (e.g. `devstack-sui.image:<hash>`).
// When the supervisor's next `dockerImage({build})` resolves that tag,
// docker reports "tag already exists" → build short-circuits → the
// loaded snapshot content is used. Without this retag the snapshot
// image sits unused and the supervisor builds a fresh base image,
// running a new genesis against it — chain state lost.
// -----------------------------------------------------------------------------

export const tagImage = (
	source: string,
	target: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'tag',
			'docker.source': source,
			'docker.target': target,
		});
		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['tag', source, target]),
			'docker tag',
		);
	}).pipe(Effect.withSpan('Docker.tagImage'));

// -----------------------------------------------------------------------------
// inspectContainerImage — read the image tag a container was created from.
//
// `docker inspect --format '{{.Config.Image}}'` returns the tag STRING
// the user passed to `docker run -i <tag>` (or `docker create -i <tag>`),
// NOT the image content hash. That's exactly what we want for
// snapshot.save: by recording the supervisor's content-addressed tag at
// commit time, restore can retag the loaded snapshot image back to that
// same string so the supervisor's name-then-image probe in `Docker.run`
// finds a match.
// -----------------------------------------------------------------------------

export const inspectContainerImage = (
	containerId: string,
): Effect.Effect<string | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.Config.Image}}',
			containerId,
		]);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const trimmed = out.trim();
		return trimmed.length === 0 ? undefined : trimmed;
	}).pipe(Effect.withSpan('Docker.inspectContainerImage'));
