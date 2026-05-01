// Move-package publish helper. `publishMovePackage(...)` builds a Move
// package inside the running sui-localnet container (no host-side `sui`
// install needed) and submits the publish tx via the JSON-RPC SDK.
// Implements the source-digest gate: when a prior cache entry exists
// with matching source-digest + chainId AND the cached packageId still
// resolves on-chain, the publish is skipped.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Signer } from '@mysten/sui/cryptography';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

import type { Package } from '../core/types.js';
import { objectTypeMatchesFilter } from './match-type.js';

const CONTAINER_BUILD_PATH = '/tmp/devstack-move-build';

interface BuildOutput {
	modules: string[];
	dependencies: string[];
}

export interface PublishCacheEntry {
	packageId: string;
	captured: Record<string, string>;
	sourceDigest: string;
	/** Chain identifier the cached entry was published against. Mismatch
	 * means a force-regenesis happened — bust the cache. */
	chainId: string;
}

export interface PublishMovePackageOptions {
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
		const built = buildOnHost(packagePath, moveBuildEnv);
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
		const built = buildInContainer(containerName, moveBuildEnv);
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
 * Extracted from per-app boilerplate so `definePublishAction` and any
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
	const hash = createHash('sha256');
	for (const file of files) {
		hash.update(relative(packagePath, file));
		hash.update('\0');
		hash.update(readFileSync(file));
		hash.update('\0');
	}
	return hash.digest('hex');
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === 'build' || entry === 'tests' || entry === '.git') continue;
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) {
			collectSourceFiles(full, out);
		} else if (entry === 'Move.toml' || entry.endsWith('.move')) {
			out.push(full);
		}
	}
	return out;
}

function copyIntoContainer(containerName: string, hostPath: string): void {
	const cleanup = spawnSync('docker', [
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
	const cp = spawnSync('docker', [
		'cp',
		`${hostPath}/.`,
		`${containerName}:${CONTAINER_BUILD_PATH}/`,
	]);
	if (cp.status !== 0) {
		throw new Error(`devstack publish: docker cp failed: ${cp.stderr.toString()}`);
	}
}

function buildInContainer(containerName: string, moveBuildEnv: string): BuildOutput {
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
	const result = spawnSync(
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
		{ encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`sui move build failed (exit ${result.status}):\n${result.stderr}`);
	}
	return parseBuildJson(result.stdout, result.stderr);
}

/**
 * Host-side `sui move build`. Used by live-network deploys where the
 * localnet container isn't running. The user must have the `sui` CLI on
 * PATH; we surface a clear error if not (the common case is "they were
 * running localnet but switched to testnet for a one-off deploy"; the
 * fix is `cargo install --git https://github.com/MystenLabs/sui --branch
 * testnet sui` or the official binaries).
 */
function buildOnHost(packagePath: string, moveBuildEnv: string): BuildOutput {
	const probe = spawnSync('sui', ['--version'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(
			'publishMovePackage: host `sui` CLI not found on PATH. Install from ' +
				'https://docs.sui.io/guides/developer/getting-started/sui-install (>= 1.51.1). ' +
				'Required for live-network publishes; localnet publishes use the in-container CLI.',
		);
	}
	const result = spawnSync(
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
		{ encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, RUST_LOG: 'error' } },
	);
	if (result.status !== 0) {
		throw new Error(`host sui move build failed (exit ${result.status}):\n${result.stderr}`);
	}
	return parseBuildJson(result.stdout, result.stderr);
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
