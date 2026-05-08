// Move-package publish helper. `publishMovePackage(...)` builds a Move
// package inside the running sui-localnet container (no host-side `sui`
// install needed) and submits the publish tx via the JSON-RPC SDK.
// Implements the source-digest gate: when a prior cache entry exists
// with matching source-digest + chainId AND the cached packageId still
// resolves on-chain, the publish is skipped.
//
// `node:*` modules are loaded via top-level `await import(...)` so
// the module's static surface stays browser-safe — `actions/publish.ts`
// is reachable from `examples/*` Vite builds via the main barrel's
// `publishMove` re-export, and Rollup binds named/namespace imports
// against externals during parse (which fails for
// `__vite-browser-external`'s empty surface). Dynamic `import(...)`
// expressions bypass that bind step; the wallet's tree-shake then
// drops this whole module thanks to the package's `sideEffects: false`.

const [nodeChildProcess, nodeCrypto, nodeFs, nodePath] = await Promise.all([
	import('node:child_process'),
	import('node:crypto'),
	import('node:fs'),
	import('node:path'),
]);

import type { Signer } from '@mysten/sui/cryptography';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

import type { Package } from '../core/types.js';
import { objectTypeMatchesFilter } from './match-type.js';
import { wireStream } from './stream-lines.js';

const CONTAINER_BUILD_PATH = '/tmp/devstack-move-build';

interface BuildOutput {
	modules: string[];
	dependencies: string[];
}

interface PublishCacheEntry {
	packageId: string;
	captured: Record<string, string>;
	sourceDigest: string;
	/** Chain identifier the cached entry was published against. Mismatch
	 * means a force-regenesis happened — bust the cache. */
	chainId: string;
}

interface PublishMovePackageOptions {
	/** Sui-localnet container name. Required when `buildEnv: 'container'`
	 * (the default); ignored when `buildEnv: 'host'`. */
	containerName?: string;
	packagePath: string;
	publisher: Signer;
	client: SuiJsonRpcClient;
	capture?: Record<string, string>;
	chainId: string;
	prior?: PublishCacheEntry;
	/**
	 * Where to compile the Move package. `'container'` (default) shells
	 * `sui move build` inside the localnet container — no host sui CLI
	 * needed. `'host'` shells the host's `sui` CLI (must be installed on
	 * PATH); used by live-network deploys where the container isn't
	 * running. Bytecode is identical regardless of build location.
	 */
	buildEnv?: 'container' | 'host';
	/** Sui environment label passed to `--build-env`. Default `'testnet'`
	 * — packages without an explicit `[environments]` block accept it,
	 * and Sui resolves framework deps from its bundled cache. */
	moveBuildEnv?: string;
	/** Optional per-action diagnostic stream. When wired (typically the
	 * action's `ctx.appendLog`), each newline-delimited line of `sui move
	 * build`'s stderr is forwarded as it arrives — so a 60s cargo
	 * recompile or a syntax-error compile shows progress incrementally
	 * instead of looking frozen until the buffered tail dumps at the
	 * end. Stdout stays buffered (we parse it as JSON for the bytecode
	 * dump). */
	appendLog?: (line: string) => void;
}

export interface PublishMovePackageResult {
	packageId: string;
	captured: Record<string, string>;
	sourceDigest: string;
	/** Set when this call actually published; absent on cache hit. */
	digest?: string;
	cacheHit: boolean;
}

export async function publishMovePackage(
	opts: PublishMovePackageOptions,
): Promise<PublishMovePackageResult> {
	const { containerName, packagePath, publisher, client, capture, chainId, prior } = opts;
	const buildEnv = opts.buildEnv ?? 'container';
	const moveBuildEnv = opts.moveBuildEnv ?? 'testnet';

	const sourceDigest = computeSourceDigest(packagePath);

	if (prior !== undefined && prior.sourceDigest === sourceDigest && prior.chainId === chainId) {
		// Cheap on-chain liveness check: a force-regenesis with the same
		// chainId is impossible (chainId derives from genesis), so the only
		// way the cached package would be missing is if the user ran
		// `devstack down --purge` and rebuilt. `getObject` is one round trip.
		const onChain = await client.getObject({ id: prior.packageId });
		if (onChain.data !== null && onChain.data !== undefined) {
			return {
				packageId: prior.packageId,
				captured: prior.captured,
				sourceDigest,
				cacheHit: true,
			};
		}
	}

	let modules: string[];
	let dependencies: string[];
	if (buildEnv === 'host') {
		const built = await buildOnHost(packagePath, moveBuildEnv, opts.appendLog);
		modules = built.modules;
		dependencies = built.dependencies;
	} else {
		if (containerName === undefined) {
			throw new Error(
				'publishMovePackage: buildEnv="container" requires containerName. ' +
					'Pass buildEnv: "host" for live-network publishes.',
			);
		}
		copyIntoContainer(containerName, packagePath);
		const built = await buildInContainer(containerName, moveBuildEnv, opts.appendLog);
		modules = built.modules;
		dependencies = built.dependencies;
	}

	const tx = new Transaction();
	const upgradeCap = tx.publish({ modules, dependencies });
	tx.transferObjects([upgradeCap], publisher.toSuiAddress());

	const result = await client.signAndExecuteTransaction({
		signer: publisher,
		transaction: tx,
		options: { showObjectChanges: true, showEffects: true },
	});

	if (result.effects?.status.status !== 'success') {
		throw new Error(`Publish failed: ${result.effects?.status.error ?? 'unknown'}`);
	}
	await client.waitForTransaction({ digest: result.digest });

	const changes = result.objectChanges ?? [];
	const published = changes.find((c) => c.type === 'published');
	if (published === undefined || published.type !== 'published') {
		throw new Error('Publish: no "published" change in result');
	}
	const packageId = published.packageId;
	const captured = applyCapture(capture, changes);

	return { packageId, captured, sourceDigest, digest: result.digest, cacheHit: false };
}

/**
 * Maps a registry `Package` entry to the cache shape `publishMovePackage`
 * accepts as `prior`. Returns `undefined` when the entry is missing or
 * lacks the digest/chainId fields needed to gate a republish (older
 * manifests, or entries from imports that don't carry source digests).
 *
 * Extracted from per-app boilerplate so `publish()` and any
 * remaining hand-rolled Publish actions can share the same fallback
 * rules.
 */
export function buildPriorCacheEntry(pkg: Package | undefined): PublishCacheEntry | undefined {
	if (pkg === undefined) return undefined;
	if (pkg.sourceDigest === undefined || pkg.chainId === undefined) return undefined;
	return {
		packageId: pkg.packageId,
		captured: pkg.captured,
		sourceDigest: pkg.sourceDigest,
		chainId: pkg.chainId,
	};
}

/** SHA-256 over every `.move` file + `Move.toml` under `packagePath`,
 *  hashed in path-sorted order so the result is reproducible across
 *  machines and filesystems. `build/` and `tests/` are excluded. */
export function computeSourceDigest(packagePath: string): string {
	const files = collectSourceFiles(packagePath);
	files.sort();
	const hash = nodeCrypto.createHash('sha256');
	for (const file of files) {
		hash.update(nodePath.relative(packagePath, file));
		hash.update('\0');
		hash.update(nodeFs.readFileSync(file));
		hash.update('\0');
	}
	return hash.digest('hex');
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of nodeFs.readdirSync(dir)) {
		if (entry === 'build' || entry === 'tests' || entry === '.git') continue;
		const full = nodePath.join(dir, entry);
		const s = nodeFs.statSync(full);
		if (s.isDirectory()) {
			collectSourceFiles(full, out);
		} else if (entry === 'Move.toml' || entry.endsWith('.move')) {
			out.push(full);
		}
	}
	return out;
}

function copyIntoContainer(containerName: string, hostPath: string): void {
	const cleanup = nodeChildProcess.spawnSync('docker', [
		'exec',
		containerName,
		'sh',
		'-c',
		`rm -rf ${CONTAINER_BUILD_PATH} && mkdir -p ${CONTAINER_BUILD_PATH}`,
	]);
	if (cleanup.status !== 0) {
		throw new Error(
			`devstack publish: failed to prepare ${CONTAINER_BUILD_PATH}: ${cleanup.stderr.toString()}`,
		);
	}
	const cp = nodeChildProcess.spawnSync('docker', [
		'cp',
		`${hostPath}/.`,
		`${containerName}:${CONTAINER_BUILD_PATH}/`,
	]);
	if (cp.status !== 0) {
		throw new Error(`devstack publish: docker cp failed: ${cp.stderr.toString()}`);
	}
}

async function buildInContainer(
	containerName: string,
	moveBuildEnv: string,
	appendLog: ((line: string) => void) | undefined,
): Promise<BuildOutput> {
	// `RUST_LOG=error` because Sui v1.71 emits tracing INFO to stdout
	// during `move build`, which would otherwise pollute the JSON output.
	//
	// `--build-env testnet` is required because sui CLI 1.71's default
	// (the active env from `client.yaml`) is `local` on a freshly-bootstrapped
	// container, and `sui move build` rejects `local` with "Could not
	// determine the correct dependencies to use for `local`; pass one of
	// `--build-env testnet` or `--build-env mainnet`." `testnet` is
	// canonical: packages without an `[environments]` block accept it and
	// the CLI auto-resolves Sui + MoveStdlib without internet round-trips
	// after the first build (deps are content-addressed in the image's
	// `~/.move` cache).
	//
	// Async `spawn` (not `spawnSync`) so `sui move build`'s stderr can
	// stream through `appendLog` line-by-line as the build progresses.
	// A cold cargo recompile takes 10–60s; with `spawnSync`'s buffered
	// stderr, the supervisor row sat at "running" with no output until
	// the wall of compile messages dumped at the end. Async streaming
	// surfaces compile errors and progress lines incrementally.
	return runMoveBuild(
		'docker',
		[
			'exec',
			'-e',
			'RUST_LOG=error',
			containerName,
			'sui',
			'move',
			'build',
			'--path',
			CONTAINER_BUILD_PATH,
			'--dump-bytecode-as-base64',
			'--build-env',
			moveBuildEnv,
		],
		{
			label: 'sui move build',
			appendLog,
		},
	);
}

/**
 * Host-side `sui move build`. Used by live-network deploys where the
 * localnet container isn't running. The user must have the `sui` CLI on
 * PATH; we surface a clear error if not (the common case is "they were
 * running localnet but switched to testnet for a one-off deploy"; the
 * fix is `cargo install --git https://github.com/MystenLabs/sui --branch
 * testnet sui` or the official binaries).
 */
async function buildOnHost(
	packagePath: string,
	moveBuildEnv: string,
	appendLog: ((line: string) => void) | undefined,
): Promise<BuildOutput> {
	const probe = nodeChildProcess.spawnSync('sui', ['--version'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(
			'publishMovePackage: host `sui` CLI not found on PATH. Install from ' +
				'https://docs.sui.io/guides/developer/getting-started/sui-install (>= 1.51.1). ' +
				'Required for live-network publishes; localnet publishes use the in-container CLI.',
		);
	}
	return runMoveBuild(
		'sui',
		[
			'move',
			'build',
			'--path',
			packagePath,
			'--dump-bytecode-as-base64',
			'--build-env',
			moveBuildEnv,
		],
		{
			label: 'host sui move build',
			appendLog,
			env: { ...process.env, RUST_LOG: 'error' },
		},
	);
}

interface RunMoveBuildOptions {
	label: string;
	appendLog: ((line: string) => void) | undefined;
	env?: NodeJS.ProcessEnv;
}

/** Spawn `sui move build` (or `docker exec sui move build`) and stream
 * its stderr through `appendLog` line-by-line while buffering stdout
 * for JSON parsing. Throws with the buffered stderr on non-zero exit
 * so the existing error format is preserved.
 *
 * Why split stdout vs stderr: stdout carries the bytecode dump as a
 * single JSON line we feed into `parseBuildJson`; mixing it with the
 * progress stream would garble both. Stderr carries cargo compile
 * progress + Move type-check errors — the parts the user actually
 * needs to see while the build runs. */
function runMoveBuild(
	command: string,
	args: string[],
	opts: RunMoveBuildOptions,
): Promise<BuildOutput> {
	return new Promise((resolve, reject) => {
		const child = nodeChildProcess.spawn(command, args, {
			env: opts.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
		});
		// Always buffer stderr (we need it for the error message on
		// non-zero exit); ALSO stream it line-by-line through appendLog
		// when wired so the supervisor row shows progress as the build
		// runs. The pre-async path buffered stderr exclusively, so a 60s
		// `sui move build` froze the row with no output until the very
		// end.
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
		});
		if (opts.appendLog !== undefined) {
			wireStream(child.stderr, opts.appendLog);
		}
		child.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(
					new Error(
						`${opts.label}: ${command} not found on PATH. ` +
							(command === 'sui'
								? 'Install from https://docs.sui.io/guides/developer/getting-started/sui-install.'
								: "Install Docker Desktop, Colima, or your distro's docker package and start the engine."),
					),
				);
				return;
			}
			reject(err);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`${opts.label} failed (exit ${code}):\n${stderr}`));
				return;
			}
			try {
				resolve(parseBuildJson(stdout, stderr));
			} catch (err) {
				reject(err);
			}
		});
	});
}

function parseBuildJson(stdout: string, stderr: string): BuildOutput {
	const jsonLine = stdout
		.split('\n')
		.find((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));
	if (jsonLine === undefined) {
		throw new Error(
			`sui move build did not emit a JSON line.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
		);
	}
	return JSON.parse(jsonLine) as BuildOutput;
}

function applyCapture(
	capture: Record<string, string> | undefined,
	changes: readonly { type: string; objectType?: string; objectId?: string }[],
): Record<string, string> {
	const out: Record<string, string> = {};
	if (capture === undefined) return out;
	for (const [manifestKey, typeFilter] of Object.entries(capture)) {
		const found = changes.find(
			(c) =>
				c.type === 'created' &&
				c.objectType !== undefined &&
				objectTypeMatchesFilter(c.objectType, typeFilter),
		);
		if (found?.objectId !== undefined) out[manifestKey] = found.objectId;
	}
	return out;
}
