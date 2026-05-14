// Image-layer docker wrappers — `pull`, `build`, `saveImage`, `loadImage`.
// Each shells out via the shared `runCapturingOrFail` helper so the
// error envelope (truncated stdout/stderr in `DockerError.message`)
// matches the rest of the slice.

import { isAbsolute, resolve } from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { DockerError } from '../../primitives/errors.js';
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

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['pull', image]),
			'docker pull',
		);

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', image]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker pull',
					message: `docker image inspect returned empty digest for ${image}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.pull'));

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
					op: 'docker build',
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
					op: 'docker load',
					message: `docker load produced no "Loaded image:" line for ${tarPath}`,
					stdout,
				}),
			);
		}
		return { tag: match[1] };
	}).pipe(Effect.withSpan('Docker.loadImage'));
