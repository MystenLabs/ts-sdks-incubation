// sui-move-build — shared Sui Move build helpers.
//
// ARCHITECTURE NOTE — substrate-name-awareness escape hatch:
//
// Like `sui-execute/`, this is an L1-adjacent Sui-aware helper. It owns
// the mechanical "scrub Move.lock → run sui move build → parse bytecode"
// path so Move-publishing plugins do not import each other's internals.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { Effect, Schema, type Scope } from 'effect';

import type {
	ContainerBuildContext,
	ContainerRuntime,
	ExecResult,
	ImageRef,
} from '../../../contracts/container-runtime.ts';
import { contentHash, type ChainId, type ContentHash } from '../../brand.ts';

export type MoveBuildPhase = 'hash' | 'scrub' | 'build' | 'parse';

export const DEFAULT_SUI_CLI_VERSION = 'devnet-v1.71.0';

export const suiCliImageBuildContext = (
	version = DEFAULT_SUI_CLI_VERSION,
): ContainerBuildContext => ({
	contextPath: new URL('../../../../images/', import.meta.url).pathname,
	dockerfile: 'sui/Dockerfile',
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
	return out.join('\n');
};

export const CONTAINER_SCRUB_AWK_SCRIPT = [
	'/^\\[pinned\\./ { skip=1; next }',
	'/^\\[/ && !/^\\[pinned\\./ { skip=0 }',
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

export const scrubLocksContainerShellScript = containerScrubShellScript;

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

export const hostBuildArgv = (input: MoveBuildInput): ReadonlyArray<string> => [
	'move',
	'build',
	'--path',
	input.packagePath,
	'-e',
	'testnet',
	'--no-tree-shaking',
	'--dump-bytecode-as-base64',
	'--with-unpublished-dependencies',
];

export const containerInnerScript = (pkgName: string): string => {
	const scrub = containerScrubShellScript('/workspace', '/root/.move');
	const build =
		`exec sui move build --path /workspace/${shellQuote(pkgName)} ` +
		`-e testnet --no-tree-shaking --dump-bytecode-as-base64 ` +
		`--with-unpublished-dependencies`;
	return ['set -e', scrub, build].join('; ');
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

export const scrubLocksHost = (
	sourcePath: string,
	moveHomeRoot: string,
): Effect.Effect<void, MoveBuildError, Scope.Scope> =>
	Effect.tryPromise({
		try: async () => {
			const ownLocks = await findMoveLockFiles(sourcePath);
			for (const f of ownLocks) await scrubOneLockFile(f);

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

interface SuiBuildJson {
	readonly modules: ReadonlyArray<string>;
	readonly dependencies: ReadonlyArray<string>;
}

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
			const parsed = JSON.parse(trimmed) as Partial<SuiBuildJson>;
			if (!parsed || !Array.isArray(parsed.modules) || !Array.isArray(parsed.dependencies)) {
				throw new Error(
					`unexpected sui move build JSON shape: keys=${Object.keys(parsed ?? {}).join(',')}`,
				);
			}
			const modules = parsed.modules.map((m, i) => {
				if (typeof m !== 'string') {
					throw new Error(`module[${i}] is not a base64 string: typeof=${typeof m}`);
				}
				return decodeBase64Module(m);
			});
			const dependencies = parsed.dependencies.map((d, i) => {
				if (typeof d !== 'string') {
					throw new Error(`dependencies[${i}] is not a string: typeof=${typeof d}`);
				}
				return d;
			});
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
	op: 'docker exec' | 'docker run --rm' | 'host sui',
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

const buildViaOneShot = (
	inputs: BuildInputs,
	runtime: ContainerRuntime,
	image: ImageRef,
): Effect.Effect<BuildOutput, MoveBuildError, Scope.Scope> =>
	Effect.gen(function* () {
		const parent = dirname(inputs.sourcePath);
		const pkgName = basename(inputs.sourcePath);
		const inner = containerInnerScript(pkgName);
		const moveHome = join(homedir(), '.move');
		yield* ensureMoveHomeMountSource(moveHome, inputs.sourcePath, inputs.packageName);
		const result = yield* runtime
			.runOneShot({
				image,
				entrypoint: 'sh',
				argv: ['-c', inner],
				mounts: [
					{ source: parent, target: '/workspace' },
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
