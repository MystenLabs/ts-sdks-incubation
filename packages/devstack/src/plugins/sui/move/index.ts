// sui-move-build — shared Sui Move build helpers.
//
// Lives in `plugins/sui`. Owns the mechanical "scrub Move.lock → run
// sui move build → parse bytecode" path so Move-publishing plugins do
// not import each other's internals.

import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import { Effect, Schema, type Scope } from 'effect';

import type {
	ContainerBuildContext,
	ContainerRuntime,
	ExecResult,
	ImageRef,
} from '../../../contracts/container-runtime.ts';
import { contentHash, type ChainId, type ContentHash } from '../../../substrate/brand.ts';
import { mintRandomSuffix } from '../../../substrate/runtime/random-suffix.ts';
import { decodeJsonTextSync } from '../../../substrate/runtime/runtime-decode.ts';

export type MoveBuildPhase = 'hash' | 'scrub' | 'build' | 'parse';

export const DEFAULT_SUI_CLI_VERSION = 'devnet-v1.71.0';

export const suiCliImageBuildContext = (
	version = DEFAULT_SUI_CLI_VERSION,
): ContainerBuildContext => ({
	contextPath: new URL('../../../../images/', import.meta.url).pathname,
	dockerfile: 'sui/Dockerfile',
	fingerprintPaths: ['sui/Dockerfile', 'sui/entrypoint.sh', '_shared/signal-forward.sh'],
	buildArgs: { SUI_VERSION: version },
});

export class MoveBuildError extends Schema.TaggedErrorClass<MoveBuildError>()('MoveBuildError', {
	phase: Schema.Literals(['hash', 'scrub', 'build', 'parse']),
	sourcePath: Schema.String,
	packageName: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

const moveBuildError = (
	phase: MoveBuildPhase,
	parts: {
		readonly sourcePath: string;
		readonly packageName: string;
		readonly message: string;
		readonly cause?: unknown;
	},
): MoveBuildError =>
	new MoveBuildError({
		phase,
		sourcePath: parts.sourcePath,
		packageName: parts.packageName,
		message: parts.message,
		...(parts.cause !== undefined ? { cause: parts.cause } : {}),
	});

export interface MoveBuildContainer {
	readonly runBuild: (hostPackagePath: string) => Effect.Effect<ExecResult, unknown, Scope.Scope>;
}

export interface BuildInputs {
	readonly sourcePath: string;
	readonly packageName: string;
	readonly chainId: ChainId | string;
	readonly buildContainer?: MoveBuildContainer;
	readonly runtime?: ContainerRuntime;
	readonly buildImage?: ImageRef;
}

export interface BuildOutput {
	readonly modules: ReadonlyArray<Uint8Array>;
	readonly dependencies: ReadonlyArray<string>;
}

export const stripPinnedSections = (source: string): string => {
	const lines = source.split('\n');
	const out: Array<string> = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('[')) {
			const header = trimmed.replace(/\s+/g, '');
			if (header.startsWith('[pinned.') || header === '[env]' || header.startsWith('[env.')) {
				skipping = true;
				continue;
			}
			skipping = false;
		}
		if (!skipping) out.push(line);
	}
	if (skipping && source.endsWith('\n') && out.at(-1) === '') out.push('');
	return out.join('\n');
};

export const CONTAINER_SCRUB_AWK_SCRIPT = [
	'/^\\[pinned\\./ || /^\\[env(\\.|\\])/ { skip=1; next }',
	'/^\\[/ && !/^\\[pinned\\./ && !/^\\[env(\\.|\\])/ { skip=0 }',
	'!skip { print }',
].join('\n');

export const containerScrubShellScript = (workspaceRoot: string, moveHomeRoot: string): string => {
	const lines = CONTAINER_SCRUB_AWK_SCRIPT.split('\n')
		.map((l) => `'${l}'`)
		.join(' ');
	const stage = `printf '%s\\n%s\\n%s\\n' ${lines} > /tmp/scrub-move-lock.awk`;
	const findPkg =
		`find ${workspaceRoot} -type f -name Move.lock ` +
		`-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';'`;
	const findCache =
		`[ -d ${moveHomeRoot}/git ] && find ${moveHomeRoot}/git -type f -name Move.lock ` +
		`-not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';' || true`;
	return [stage, findPkg, findCache].join('; ');
};

export interface MoveBuildInput {
	readonly packagePath: string;
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
}

export interface MoveBuildOutput {
	readonly exitCode: number;
	readonly stdoutJson: string;
	readonly stderr: string;
}

export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

export const extractTrailingJson = (text: string): string => {
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) return trimmed;
	const idx = trimmed.lastIndexOf('{');
	if (idx === -1) return trimmed;
	return trimmed.slice(idx);
};

export const containerInnerScript = (pkgName: string): string => {
	// Copy the WHOLE mounted tree into an in-container scratch dir and scrub +
	// build the package THERE, never `/workspace/<pkg>` directly. `/workspace`
	// is a bind mount of the developer's real source tree (the per-app build
	// container in `chain-build-container.ts` mounts the app dir as-is), and the
	// scrub's `gawk -i inplace` rewrite of Move.lock would corrupt their
	// checked-in pinned deps if run against the mount.
	//
	// Two reasons we copy `/workspace/.` (the whole tree) rather than only
	// `/workspace/<pkgName>`:
	//   1. NESTED PACKAGES. `pkgName` is the package path RELATIVE to the
	//      bind-mounted app dir (e.g. `packages/demo`), so it can contain a
	//      slash. Copying only `/workspace/<pkgName>` into
	//      `/tmp/move-build-$$/<pkgName>` would need the intermediate
	//      `packages/` dir to exist first — it doesn't, and `set -e` would
	//      abort the build before `sui move build` ran.
	//   2. SIBLING LOCAL DEPS. A package can reference siblings via
	//      `{ local = "../token" }`. A scoped copy of only the package subtree
	//      drops those, failing the build with "Invalid directory at ../…".
	// Copying the whole tree both materialises the nested path AND carries the
	// sibling `../` deps. The mount itself is never rewritten (mirrors
	// `containerInnerScriptOneShot`, whose host-side staging tree is the disposable
	// copy there; here the in-container copy is the disposable one).
	//
	// `$$` (the shell PID) scopes the scratch dir per exec so concurrent
	// builds of the same package don't share a tree.
	const quotedPkg = shellQuote(pkgName);
	const scratchRoot = '/tmp/move-build-$$';
	const scratchPkg = `${scratchRoot}/${quotedPkg}`;
	const stage = `rm -rf ${scratchRoot} && mkdir -p ${scratchRoot} && cp -a /workspace/. ${scratchRoot}/`;
	// Scrub the whole scratch tree AND the mounted Move git cache. The cache
	// (`/root/.move/git`) is process-shared mutable state we legitimately want
	// scrubbed so a stale pin can't leak into the build; the scratch tree is the
	// disposable copy, so scrubbing all of it (package + staged siblings) is safe.
	const scrub = containerScrubShellScript(scratchRoot, '/root/.move');
	const build =
		`sui move build --path ${scratchPkg} ` +
		`-e testnet --no-tree-shaking --dump-bytecode-as-base64 ` +
		`--with-unpublished-dependencies`;
	const cleanup = `rm -rf ${scratchRoot}`;
	return [
		'set -e',
		stage,
		scrub,
		'set +e',
		build,
		'status=$?',
		'set -e',
		scrub,
		cleanup,
		'exit "$status"',
	].join('; ');
};

/** One-shot-path inner script. Mirrors {@link containerInnerScript} — both copy
 *  the WHOLE `/workspace` tree into an in-container scratch dir and scrub + build
 *  THERE, never the mount in place. The difference is only WHAT is mounted at
 *  `/workspace`: the exec path bind-mounts the developer's real app dir (so the
 *  whole-tree copy naturally carries nested packages + sibling `../` deps),
 *  whereas the one-shot path mounts a disposable host-side staging copy whose
 *  transitive local deps were pre-staged (see `stageLocalMoveDeps`). Copying only
 *  `/workspace/<pkg>` would drop sibling local dependencies
 *  (`{ local = "../token" }`), failing the build with "Invalid directory at ../…". */
export const containerInnerScriptOneShot = (pkgName: string): string => {
	const quotedPkg = shellQuote(pkgName);
	const scratchRoot = '/tmp/move-build-$$';
	const scratchPkg = `${scratchRoot}/${quotedPkg}`;
	// Copy the WHOLE staging mount (package + its staged local `../` deps) into
	// an in-container scratch tree and scrub + build THERE — never the mounted
	// host staging dir. Building in the mount leaves root-owned `build/` +
	// scrubbed Move.lock files behind that the (non-root) host can't remove,
	// failing scope cleanup with EACCES. Copying ALL of /workspace (like
	// containerInnerScript) keeps sibling local deps like `{ local = "../token" }`
	// present in the scratch tree.
	const stage = `rm -rf ${scratchRoot} && mkdir -p ${scratchRoot} && cp -a /workspace/. ${scratchRoot}/`;
	const scrub = containerScrubShellScript(scratchRoot, '/root/.move');
	const build =
		`sui move build --path ${scratchPkg} ` +
		`-e testnet --no-tree-shaking --dump-bytecode-as-base64 ` +
		`--with-unpublished-dependencies`;
	const cleanup = `rm -rf ${scratchRoot}`;
	return [
		'set -e',
		stage,
		scrub,
		'set +e',
		build,
		'status=$?',
		'set -e',
		scrub,
		cleanup,
		'exit "$status"',
	].join('; ');
};

const isHashedFile = (name: string): boolean =>
	name === 'Move.toml' || name === 'Move.lock' || name.endsWith('.move');

const isSkippedDir = (name: string): boolean =>
	name === 'build' || name === 'node_modules' || name === '.git' || name.startsWith('.');

const collectHashedSources = async (root: string): Promise<ReadonlyArray<string>> => {
	const out: Array<string> = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: ReadonlyArray<{
			readonly name: string;
			readonly isDirectory: () => boolean;
			readonly isFile: () => boolean;
		}> = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (isSkippedDir(entry.name)) continue;
				await walk(join(dir, entry.name));
			} else if (entry.isFile() && isHashedFile(entry.name)) {
				const abs = join(dir, entry.name);
				try {
					const stat = await lstat(abs);
					if (stat.isFile() && !stat.isSymbolicLink()) out.push(abs);
				} catch {
					// vanished / unreadable — skip
				}
			}
		}
	};
	await walk(root);
	return out;
};

export const hashMoveSources = (sourcePath: string): Effect.Effect<ContentHash, MoveBuildError> =>
	Effect.tryPromise({
		try: async (): Promise<ContentHash> => {
			const files = await collectHashedSources(sourcePath);
			const sorted = [...files].sort((a, b) =>
				relative(sourcePath, a).localeCompare(relative(sourcePath, b)),
			);
			const hasher = createHash('sha256');
			for (const abs of sorted) {
				const rel = relative(sourcePath, abs);
				const raw = await readFile(abs, 'utf8');
				const normalised = basename(abs) === 'Move.lock' ? stripPinnedSections(raw) : raw;
				hasher.update(rel);
				hasher.update('\0');
				hasher.update(normalised);
				hasher.update('\0');
			}
			return contentHash(hasher.digest('hex'));
		},
		catch: (cause): MoveBuildError =>
			moveBuildError('hash', {
				sourcePath,
				packageName: sourcePath,
				message: `source-tree hash failed: ${String((cause as Error)?.message ?? cause)}`,
				cause,
			}),
	});

const expandHome = (p: string): string =>
	p.startsWith('~/') ? join(homedir(), p.slice(2)) : p === '~' ? homedir() : p;

const findMoveLockFiles = async (root: string): Promise<ReadonlyArray<string>> => {
	const out: Array<string> = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: ReadonlyArray<{
			readonly name: string;
			readonly isDirectory: () => boolean;
			readonly isFile: () => boolean;
		}> = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') {
				continue;
			}
			const child = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile() && entry.name === 'Move.lock') {
				try {
					const stat = await lstat(child);
					if (stat.isFile() && !stat.isSymbolicLink()) out.push(child);
				} catch {
					// unreadable / vanished — skip
				}
			}
		}
	};
	await walk(root);
	return out;
};

const scrubOneLockFile = async (path: string): Promise<void> => {
	const original = await readFile(path, 'utf8');
	const scrubbed = stripPinnedSections(original);
	if (scrubbed === original) return;
	await writeFile(path, scrubbed, 'utf8');
};

const scrubCachedLockFiles = async (root: string): Promise<void> => {
	const cachedLocks = await findMoveLockFiles(root);
	for (const f of cachedLocks) {
		try {
			await scrubOneLockFile(f);
		} catch {
			// The Docker build scrubs the mounted Move cache again from inside the container.
		}
	}
};

// Scrub ONLY the shared Move git cache (`~/.move/git`), never the caller's
// source tree. The package's own Move.lock is scrubbed inside the container on
// a disposable copy (see `containerInnerScript`), so rewriting the developer's
// checked-in Move.lock here would corrupt their pinned deps for no benefit. The
// cache is process-shared mutable state, so scrubbing it host-side keeps a stale
// pin from leaking into the build.
export const scrubLocksHost = (
	sourcePath: string,
	moveHomeRoot: string,
): Effect.Effect<void, MoveBuildError, Scope.Scope> =>
	Effect.tryPromise({
		try: async () => {
			const moveHome = expandHome(moveHomeRoot);
			const gitCache = join(moveHome, 'git');
			try {
				await lstat(gitCache);
			} catch {
				return;
			}
			await scrubCachedLockFiles(gitCache);
		},
		catch: (cause): MoveBuildError =>
			moveBuildError('scrub', {
				sourcePath,
				packageName: sourcePath,
				message: `scrub host locks failed (root=${moveHomeRoot})`,
				cause,
			}),
	});

const SuiBuildJsonSchema = Schema.Struct({
	modules: Schema.Array(Schema.String),
	dependencies: Schema.Array(Schema.String),
});

const decodeBase64Module = (s: string): Uint8Array =>
	Uint8Array.from(globalThis.Buffer.from(s, 'base64'));

export const parseBuildOutput = (
	stdout: string,
	sourcePath: string,
	packageName: string,
): Effect.Effect<BuildOutput, MoveBuildError> =>
	Effect.try({
		try: (): BuildOutput => {
			const trimmed = extractTrailingJson(stdout);
			const parsed = decodeJsonTextSync(SuiBuildJsonSchema, trimmed, {
				source: 'sui move build stdout',
				message: 'unexpected sui move build JSON shape',
				mkError: (issue) => new Error(issue.message, { cause: issue.cause }),
			});
			const modules = parsed.modules.map((m) => decodeBase64Module(m));
			const dependencies = parsed.dependencies;
			return { modules, dependencies };
		},
		catch: (cause): MoveBuildError =>
			moveBuildError('parse', {
				sourcePath,
				packageName,
				message: `failed to parse sui move build output: ${String((cause as Error)?.message ?? cause)}`,
				cause,
			}),
	});

const promoteNonZero = (
	op: 'docker exec' | 'docker run --rm',
	result: ExecResult,
	sourcePath: string,
	packageName: string,
): MoveBuildError =>
	moveBuildError('build', {
		sourcePath,
		packageName,
		message:
			`${op} sui move build exited ${result.exitCode} for package "${packageName}".\n` +
			`stderr: ${result.stderr || '(empty)'}\n` +
			`stdout (tail): ${result.stdout.slice(-400) || '(empty)'}`,
	});

const ensureMoveHomeMountSource = (
	moveHome: string,
	sourcePath: string,
	packageName: string,
): Effect.Effect<void, MoveBuildError> =>
	Effect.tryPromise({
		try: () => mkdir(moveHome, { recursive: true }),
		catch: (cause): MoveBuildError =>
			moveBuildError('build', {
				sourcePath,
				packageName,
				message: `failed to create Move cache mount source "${moveHome}"`,
				cause,
			}),
	}).pipe(Effect.asVoid);

const buildViaContainerExec = (
	inputs: BuildInputs,
	bc: MoveBuildContainer,
): Effect.Effect<BuildOutput, MoveBuildError, Scope.Scope> =>
	Effect.gen(function* () {
		const result = yield* bc.runBuild(inputs.sourcePath).pipe(
			Effect.mapError(
				(err): MoveBuildError =>
					moveBuildError('build', {
						sourcePath: inputs.sourcePath,
						packageName: inputs.packageName,
						message: `buildContainer.runBuild failed: ${String(
							(err as { cause?: { message?: string } })?.cause?.message ?? err,
						)}`,
						cause: err,
					}),
			),
		);
		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				promoteNonZero('docker exec', result, inputs.sourcePath, inputs.packageName),
			);
		}
		return yield* parseBuildOutput(result.stdout, inputs.sourcePath, inputs.packageName);
	}).pipe(Effect.withSpan('sui-move-build.via-exec'));

/** `{ local = "../path" }` dependency paths, harvested from a Move.toml. */
const LOCAL_MOVE_DEP_RE = /\blocal\s*=\s*"([^"]+)"/g;

/** Copy a package's transitive local-path Move dependencies into a staging
 *  tree, preserving each dep's path RELATIVE to the staged package so
 *  references like `{ local = "../token" }` resolve. Without this, a scoped
 *  copy of only the package fails `sui move build` / `sui move summary` with
 *  "Invalid directory at ../…". Throws if a dep resolves outside `stagingRoot`
 *  (the single-mount layout can't represent it). Promise-based so the build
 *  (`MoveBuildError`) and summary (`CodegenBindingsFailed`) call sites can
 *  wrap it in their own error type. */
export const copyLocalMoveDeps = async (
	packageSrc: string,
	stagedPackage: string,
	stagingRoot: string,
): Promise<void> => {
	const staged = new Set<string>([packageSrc]);
	const walk = async (srcDir: string, stagedDir: string): Promise<void> => {
		let toml: string;
		try {
			toml = await readFile(join(srcDir, 'Move.toml'), 'utf8');
		} catch {
			return;
		}
		for (const match of toml.matchAll(LOCAL_MOVE_DEP_RE)) {
			const rel = match[1]!;
			const depSrc = resolve(srcDir, rel);
			const depStaged = resolve(stagedDir, rel);
			if (depStaged !== stagingRoot && !depStaged.startsWith(stagingRoot + sep)) {
				throw new Error(
					`local Move dependency "${rel}" of "${basename(srcDir)}" resolves outside the ` +
						`staging root; vendor it under the package tree so it can be staged.`,
				);
			}
			if (staged.has(depSrc)) {
				continue;
			}
			staged.add(depSrc);
			await cp(depSrc, depStaged, { recursive: true });
			await walk(depSrc, depStaged);
		}
	};
	await walk(packageSrc, stagedPackage);
};

/** Build-path wrapper around {@link copyLocalMoveDeps}. */
export const stageLocalMoveDeps = (
	packageSrc: string,
	stagedPackage: string,
	stagingRoot: string,
	inputs: BuildInputs,
): Effect.Effect<void, MoveBuildError> =>
	Effect.tryPromise({
		try: () => copyLocalMoveDeps(packageSrc, stagedPackage, stagingRoot),
		catch: (cause): MoveBuildError =>
			moveBuildError('scrub', {
				sourcePath: inputs.sourcePath,
				packageName: inputs.packageName,
				message: 'failed to stage local Move dependencies for the one-shot build',
				cause,
			}),
	});

const buildViaOneShot = (
	inputs: BuildInputs,
	runtime: ContainerRuntime,
	image: ImageRef,
): Effect.Effect<BuildOutput, MoveBuildError, Scope.Scope> =>
	Effect.gen(function* () {
		const pkgName = basename(inputs.sourcePath);
		const inner = containerInnerScriptOneShot(pkgName);
		const moveHome = join(homedir(), '.move');
		yield* ensureMoveHomeMountSource(moveHome, inputs.sourcePath, inputs.packageName);

		// Stage a scoped copy of the package and mount THAT, never the user's
		// source tree. The container scrub (`gawk -i inplace`) rewrites Move.lock
		// in place; pointing it at the developer's checked-in tree corrupts their
		// pinned deps. The staging dir is scope-bound (acquireRelease removes it on
		// scope close) and carries a random suffix so two concurrent builds of the
		// same package don't share a tree. We keep the `/workspace/<pkgName>` layout
		// so `containerInnerScript(pkgName)` and the mounted Move cache stay unchanged.
		const stagingRoot = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () => mkdtemp(join(tmpdir(), `move-build-${mintRandomSuffix(12)}-`)),
				catch: (cause): MoveBuildError =>
					moveBuildError('scrub', {
						sourcePath: inputs.sourcePath,
						packageName: inputs.packageName,
						message: 'failed to create staging dir for Move build copy',
						cause,
					}),
			}),
			(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
		);
		const stagedPackage = join(stagingRoot, pkgName);
		yield* Effect.tryPromise({
			try: () => cp(inputs.sourcePath, stagedPackage, { recursive: true }),
			catch: (cause): MoveBuildError =>
				moveBuildError('scrub', {
					sourcePath: inputs.sourcePath,
					packageName: inputs.packageName,
					message: `failed to stage package copy for Move build (staging=${stagedPackage})`,
					cause,
				}),
		});
		// Bring the package's transitive local `../` deps into the staging tree
		// so the in-place one-shot build resolves them (the scoped copy alone
		// would omit siblings like `{ local = "../token" }`).
		yield* stageLocalMoveDeps(inputs.sourcePath, stagedPackage, stagingRoot, inputs);

		const result = yield* runtime
			.runOneShot({
				image,
				entrypoint: 'sh',
				argv: ['-c', inner],
				mounts: [
					{ source: stagingRoot, target: '/workspace' },
					{ source: moveHome, target: '/root/.move' },
				],
				timeoutMillis: 5 * 60_000,
			})
			.pipe(
				Effect.mapError(
					(err): MoveBuildError =>
						moveBuildError('build', {
							sourcePath: inputs.sourcePath,
							packageName: inputs.packageName,
							message: `runtime.runOneShot failed: ${err.reason}: ${err.detail}`,
							cause: err,
						}),
				),
			);
		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				promoteNonZero('docker run --rm', result, inputs.sourcePath, inputs.packageName),
			);
		}
		return yield* parseBuildOutput(result.stdout, inputs.sourcePath, inputs.packageName);
	}).pipe(Effect.withSpan('sui-move-build.via-one-shot'));

export const runMoveBuild = (
	inputs: BuildInputs,
): Effect.Effect<BuildOutput, MoveBuildError, Scope.Scope> => {
	if (inputs.buildContainer !== undefined) {
		return buildViaContainerExec(inputs, inputs.buildContainer);
	}
	if (inputs.runtime !== undefined && inputs.buildImage !== undefined) {
		return buildViaOneShot(inputs, inputs.runtime, inputs.buildImage);
	}
	return Effect.fail(
		moveBuildError('build', {
			sourcePath: inputs.sourcePath,
			packageName: inputs.packageName,
			message:
				'runMoveBuild: no build container and no fresh-container runtime/image — ' +
				'host `sui` CLI path is not available without a routed ChildProcessSpawner',
		}),
	);
};
