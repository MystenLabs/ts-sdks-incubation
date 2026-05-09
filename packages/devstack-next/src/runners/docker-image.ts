import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Env, Provides, ResolvedDeps } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

const exec = promisify(execFile);

export type DockerImageContext =
	| { path: string }
	| { repo: string; rev: string; subdir?: string };

export interface DockerImageResolveArgs<TDeps> {
	env: Env;
	deps: ResolvedDeps<TDeps>;
}

export type DockerImageValue<T, TDeps> = T | ((args: DockerImageResolveArgs<TDeps>) => T);

export interface DockerImageConfig<TDeps> {
	/** Logical node name. Image tag derived as
	 * `<imagePrefix>/<name>:<contentHash>`. */
	name: string;
	deps?: TDeps;

	/** Build context. Two flavors:
	 *   - `{ path: string }` — local directory, relative to env.appDir or absolute
	 *   - `{ repo: string, rev: string, subdir?: string }` — BuildKit git URL
	 *     `https://<repo>#<rev>:<subdir>` */
	context: DockerImageContext;

	/** Path to Dockerfile. For local context: relative to context.path or
	 * absolute. For git context: relative to subdir. Default 'Dockerfile'. */
	dockerfile?: string;

	/** Build args (`--build-arg KEY=value`). Folded into the input hash;
	 * rebuild on change. Static value or computed from deps. */
	args?: DockerImageValue<Record<string, string>, TDeps>;

	/** Multi-stage `--target <stage>`. Folded into the input hash. */
	target?: string;

	/** `--platform <os/arch>`. Folded into the input hash — different
	 * platforms get different tags so the same name doesn't collide
	 * across architectures. */
	platform?: string;

	/** Tag namespace. Default `'devstack'`. Result tag:
	 * `<imagePrefix>/<name>:<contentHash>`. */
	imagePrefix?: string;
}

export interface DockerImageState {
	/** `<imagePrefix>/<name>:<contentHash>` */
	tag: string;
	/** `sha256:…` content digest from `docker image inspect`. Optional —
	 * not all images have one (e.g. images built from a single layer
	 * without a manifest). */
	digest?: string;
	builtAt: number;
}

const imageProvides = {
	tag: dep((s: DockerImageState) => s.tag),
	digest: dep((s: DockerImageState) => s.digest),
	full: dep((s: DockerImageState) => s),
} satisfies Provides<DockerImageState>;

// `dockerImage` wraps a `docker build` into a Process producer. The
// resulting image tag is content-addressed: the input hash folds in
// the build context (file tree for local, git ref+subdir for git),
// dockerfile content, build args, target stage, and platform. Same
// inputs produce the same tag; rebuild fires only when the hash flips.
//
// Provides:
//   - `tag` — full image tag string (`<prefix>/<name>:<hash>`)
//   - `digest` — content digest from `docker image inspect`, when available
//   - `full` — DockerImageState (for "I depend on this being built" patterns)
//
// Composes with `dockerContainer` via the `image` Dep:
//
//   const walrusImage = dockerImage({
//     name: 'walrus',
//     context: { repo: 'github.com/MystenLabs/walrus.git', rev: 'v0.6.0' },
//   });
//   const walrusContainer = dockerContainer({
//     name: 'walrus.node-0.container',
//     image: walrusImage.get('tag'),  // chain
//     ports: [...],
//   });
//
// Bumping a build arg flips the image's identity → container's input
// hash flips → container restarts on the new image. Automatic fan-out.
//
// No `stop` hook. Images persist across engine lifecycles by design
// (CI cache, fast warm starts). Use `docker image prune` to reclaim.
export function dockerImage<TDeps = undefined>(cfg: DockerImageConfig<TDeps>) {
	if (!cfg.name) throw new Error('dockerImage: `name` is required');
	if (!cfg.context) {
		throw new Error(`dockerImage("${cfg.name}"): \`context\` is required`);
	}
	const dockerfile = cfg.dockerfile ?? 'Dockerfile';
	const imagePrefix = cfg.imagePrefix ?? 'devstack';
	if (!IMAGE_NAME_RE.test(cfg.name)) {
		throw new Error(
			`dockerImage("${cfg.name}"): name must match ${IMAGE_NAME_RE} (lowercase, dots/dashes/underscores)`,
		);
	}
	if (!IMAGE_NAME_RE.test(imagePrefix)) {
		throw new Error(
			`dockerImage("${cfg.name}"): imagePrefix '${imagePrefix}' must match ${IMAGE_NAME_RE}`,
		);
	}

	return define<DockerImageState, typeof imageProvides, TDeps>({
		name: cfg.name,
		deps: cfg.deps ?? (undefined as unknown as TDeps),
		provides: imageProvides,
		inputs: ({ env, deps }) => {
			const args = resolveValue(cfg.args, { env, deps }) ?? {};
			return computeContentSpec({
				context: cfg.context,
				dockerfile,
				args,
				...(cfg.target !== undefined ? { target: cfg.target } : {}),
				...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
				appDir: env.appDir,
			});
		},
		start: async ({ env, deps, prior, log }) => {
			const args = resolveValue(cfg.args, { env, deps }) ?? {};
			const spec = computeContentSpec({
				context: cfg.context,
				dockerfile,
				args,
				...(cfg.target !== undefined ? { target: cfg.target } : {}),
				...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
				appDir: env.appDir,
			});
			const tag = `${imagePrefix}/${cfg.name}:${spec.contentHash}`;

			if (prior?.tag === tag && (await imageExists(tag))) {
				log(`reusing image ${tag}`);
				return prior;
			}

			const buildArgsCli = buildDockerBuildArgs({
				tag,
				context: cfg.context,
				dockerfile,
				args,
				...(cfg.target !== undefined ? { target: cfg.target } : {}),
				...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
				appDir: env.appDir,
			});
			log(`docker build ${buildArgsCli.join(' ')}`);
			await exec('docker', buildArgsCli);

			const digest = await readImageDigest(tag);
			const state: DockerImageState = { tag, builtAt: Date.now() };
			if (digest !== undefined) state.digest = digest;
			return state;
		},
	});
}

const IMAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

interface ContentSpec {
	contextSpec: string;
	dockerfile: string;
	args: Record<string, string>;
	target?: string;
	platform?: string;
	contentHash: string;
}

function computeContentSpec(input: {
	context: DockerImageContext;
	dockerfile: string;
	args: Record<string, string>;
	target?: string;
	platform?: string;
	appDir: string;
}): ContentSpec {
	const contextSpec = describeContext(input.context, input.appDir);
	const sortedArgs = Object.fromEntries(
		Object.entries(input.args).sort(([a], [b]) => a.localeCompare(b)),
	);
	const h = createHash('sha256');
	h.update(`context:${contextSpec}\0`);
	h.update(`dockerfile:${input.dockerfile}\0`);
	for (const [k, v] of Object.entries(sortedArgs)) {
		h.update(`arg:${k}=${v}\0`);
	}
	if (input.target !== undefined) h.update(`target:${input.target}\0`);
	if (input.platform !== undefined) h.update(`platform:${input.platform}\0`);
	const contentHash = h.digest('hex').slice(0, 12);
	const out: ContentSpec = {
		contextSpec,
		dockerfile: input.dockerfile,
		args: sortedArgs,
		contentHash,
	};
	if (input.target !== undefined) out.target = input.target;
	if (input.platform !== undefined) out.platform = input.platform;
	return out;
}

// Stable serialization of the build context. Local: a content hash of
// the directory tree (skipping common non-source dirs). Git: a literal
// string of `<repo>#<rev>:<subdir>` — we trust the rev to identify
// content without fetching.
function describeContext(context: DockerImageContext, appDir: string): string {
	if ('path' in context) {
		const abs = isAbsolute(context.path) ? context.path : resolve(appDir, context.path);
		return `local:${abs}|tree:${hashLocalTree(abs)}`;
	}
	const subdir = context.subdir ?? '';
	return `git:${context.repo}#${context.rev}:${subdir}`;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.devstack']);

// Recursive content hash of `root`. Stable: file paths sorted, contents
// hashed verbatim, common build/cache dirs skipped. Used so identical
// context trees produce identical tags across machines.
function hashLocalTree(root: string): string {
	if (!existsSync(root)) return '';
	const files = listFiles(root, root);
	files.sort();
	const h = createHash('sha256');
	for (const rel of files) {
		const abs = join(root, rel);
		h.update(`${rel}\0`);
		try {
			h.update(readFileSync(abs));
		} catch {
			// unreadable file; produces a hash that flips next cycle
		}
		h.update('\0');
	}
	return h.digest('hex').slice(0, 16);
}

function listFiles(root: string, current: string): string[] {
	const out: string[] = [];
	const stack: string[] = [current];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				if (statSync(full).isFile()) {
					out.push(full.slice(root.length + 1));
				}
			} catch {
				// skip
			}
		}
	}
	return out;
}

function buildDockerBuildArgs(opts: {
	tag: string;
	context: DockerImageContext;
	dockerfile: string;
	args: Record<string, string>;
	target?: string;
	platform?: string;
	appDir: string;
}): string[] {
	const cli = ['build', '-t', opts.tag];
	if (opts.platform !== undefined) cli.push('--platform', opts.platform);
	if (opts.target !== undefined) cli.push('--target', opts.target);
	for (const [k, v] of Object.entries(opts.args)) {
		cli.push('--build-arg', `${k}=${v}`);
	}
	if ('path' in opts.context) {
		const ctxAbs = isAbsolute(opts.context.path)
			? opts.context.path
			: resolve(opts.appDir, opts.context.path);
		// Dockerfile path: absolute, or relative to the context dir.
		const dfAbs = isAbsolute(opts.dockerfile)
			? opts.dockerfile
			: resolve(ctxAbs, opts.dockerfile);
		cli.push('-f', dfAbs, ctxAbs);
	} else {
		const subdir = opts.context.subdir;
		// BuildKit git URL: `<repo>#<rev>:<subdir>`. The dockerfile path
		// is relative to the (subdir-rooted) context.
		const gitUrl = `${opts.context.repo}#${opts.context.rev}${subdir ? `:${subdir}` : ''}`;
		cli.push('-f', opts.dockerfile, gitUrl);
	}
	return cli;
}

async function imageExists(tag: string): Promise<boolean> {
	try {
		await exec('docker', ['image', 'inspect', tag]);
		return true;
	} catch {
		return false;
	}
}

async function readImageDigest(tag: string): Promise<string | undefined> {
	try {
		const { stdout } = await exec('docker', [
			'image',
			'inspect',
			'-f',
			'{{.Id}}',
			tag,
		]);
		const id = stdout.trim();
		return id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function resolveValue<T, TDeps>(
	v: DockerImageValue<T, TDeps> | undefined,
	args: DockerImageResolveArgs<TDeps>,
): T | undefined {
	if (typeof v === 'function') return (v as (a: DockerImageResolveArgs<TDeps>) => T)(args);
	return v;
}
