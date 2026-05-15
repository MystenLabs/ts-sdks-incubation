import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { Effect, FileSystem } from 'effect';
import * as Docker from '../../engine/docker.js';
import { DockerError } from '../../engine/errors.js';
import { tag } from '../tag.js';

export interface DockerImage {
	readonly tag: string;
	readonly digest: string;
}

export interface DockerImageOptions<Name extends string> {
	readonly name: Name;
	readonly pull?: string;
	readonly build?: {
		readonly context: string;
		readonly dockerfile?: string;
		readonly buildArgs?: Record<string, string>;
		readonly platform?: string;
	};
}

// Directories that should never participate in the context-tree hash:
// build outputs, dependency caches, and the devstack scratch dir. Matches
// the v3 list so a same-source tree hashes identically across runners.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.devstack', 'dist', '.next', 'target']);

// Walk `contextPath` and content-hash every file, skipping `SKIP_DIRS`.
// Entries are sorted before recursion so the hash is order-independent.
// Used by the `build:` branch to fold tree state into the image tag so
// edits to the Dockerfile / context bust our cached tag — without this
// an identical `options.build` JSON shape would reuse a stale tag.
const hashLocalTree = (contextPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = createHash('sha256');
		const walk = (dir: string): Effect.Effect<void, DockerError, FileSystem.FileSystem> =>
			Effect.gen(function* () {
				const entries = (yield* fs.readDirectory(dir)).slice().sort();
				for (const name of entries) {
					if (SKIP_DIRS.has(name)) continue;
					const full = path.join(dir, name);
					const stat = yield* fs.stat(full);
					if (stat.type === 'Directory') {
						yield* walk(full);
					} else if (stat.type === 'File') {
						const rel = path.relative(contextPath, full);
						hash.update(rel + '\0');
						const content = yield* fs.readFile(full);
						hash.update(content);
						hash.update('\0');
					}
				}
			}).pipe(
				Effect.catchTag('PlatformError', (cause) =>
					Effect.fail(
						new DockerError({
							op: 'dockerImage',
							message: `hashLocalTree '${contextPath}'`,
							cause,
						}),
					),
				),
			);
		yield* walk(contextPath);
		return hash.digest('hex').slice(0, 12);
	});

export const dockerImage = <const Name extends string>(options: DockerImageOptions<Name>) =>
	tag(
		options.name,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'dockerImage.name': options.name,
				'dockerImage.mode': options.pull !== undefined ? 'pull' : 'build',
			});

			if (options.pull !== undefined) {
				const { digest } = yield* Docker.pull(options.pull).pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.fail(
							new DockerError({
								op: 'dockerImage',
								message: `dockerImage '${options.name}': pull failed`,
								cause,
							}),
						),
					),
				);
				yield* Effect.annotateCurrentSpan({
					'dockerImage.tag': options.pull,
					'dockerImage.digest': digest,
				});
				return { tag: options.pull, digest } satisfies DockerImage;
			}

			if (options.build !== undefined) {
				// Content-addressed tag from a hash of the build config *and*
				// the context tree. The config hash alone misses edits to
				// Dockerfile/source — same JSON shape → same tag → stale
				// rebuild silently reused. Folding the tree hash in busts
				// our cached tag whenever any tracked file changes, while
				// docker's own layer cache still handles partial rebuilds.
				const treeHash = yield* hashLocalTree(options.build.context);
				const configHash = createHash('sha256')
					.update(JSON.stringify(options.build))
					.digest('hex')
					.slice(0, 12);
				const tag = `devstack-${options.name}:${treeHash}-${configHash}`;
				const buildOpts: Docker.DockerBuildOptions = {
					context: options.build.context,
					tag,
					...(options.build.dockerfile !== undefined
						? { dockerfile: options.build.dockerfile }
						: {}),
					...(options.build.buildArgs !== undefined ? { buildArgs: options.build.buildArgs } : {}),
					...(options.build.platform !== undefined ? { platform: options.build.platform } : {}),
				};
				const result = yield* Docker.build(buildOpts).pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.fail(
							new DockerError({
								op: 'dockerImage',
								message: `dockerImage '${options.name}': build failed`,
								cause,
							}),
						),
					),
				);
				yield* Effect.annotateCurrentSpan({
					'dockerImage.tag': result.tag,
					'dockerImage.digest': result.digest,
				});
				return { tag: result.tag, digest: result.digest } satisfies DockerImage;
			}

			return yield* Effect.fail(
				new DockerError({
					op: 'dockerImage',
					message: `dockerImage '${options.name}': must specify either 'pull' or 'build'`,
				}),
			);
		}).pipe(Effect.withSpan(`dockerImage(${options.name})`)),
		{
			kind: 'action',
			displayTitle: `image.${options.name}`,
			display: (s) => ({ title: `image.${options.name}`, primary: s.tag }),
		},
	);
