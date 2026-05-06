// Move-package import helper. `importMovePackage(...)` ensures a content-
// addressed `dev-examples/upstream-source:<repo-slug>-<rev>` image exists
// for the requested git checkout, extracts its `/src` to a tmp host dir,
// `docker cp`s the checkout into the running sui-localnet container, and
// runs `sui client test-publish --build-env <env> --pubfile-path …
// --with-unpublished-dependencies` inside the container. The CLI handles
// transitively unpublished deps automatically — no Move.toml patching, no
// manual topo sort.
//
// The cache key is the git rev itself (content-addressable). The
// `prior` short-circuit can compare it directly without a file-tree
// hash. Mirrors how `publishMovePackage` uses `sourceDigest` to gate
// republish. Bumping `rev` busts the cache automatically (and rebuilds
// the upstream-source image).
//
// The in-container sui CLI is switched to `--env local` before
// `test-publish`. The image's auto-created client.yaml lands on
// `testnet` as active, which would route the publish at the public
// testnet RPC instead of our localnet on :9000.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair, type Signer } from '@mysten/sui/cryptography';

import { objectTypeMatchesFilter } from './match-type.js';
import { ensureUpstreamSourceImage, extractUpstreamSource } from './upstream-source.js';

const CONTAINER_IMPORT_PATH = '/tmp/devstack-imports';

export interface ImportedPackageCacheEntry {
	packageId: string;
	captured: Record<string, string>;
	deps: Record<string, string>;
	/** Git rev — content-addressable, doubles as the source digest. */
	sourceDigest: string;
	/** Chain identifier the cached entry was published against. Mismatch
	 * means a force-regenesis happened — bust the cache. */
	chainId: string;
}

interface ImportMovePackageOptions {
	containerName: string;
	repo: string;
	rev: string;
	subdir: string;
	alias: string;
	capture?: Record<string, string>;
	chainId: string;
	/** Sui environment name passed to `--build-env`. The package's Move.toml
	 * `[environments]` block must declare this name; the helper appends a
	 * stub when it's absent (a no-op at publish time, but unblocks the
	 * dep resolver). Default: `'localnet'`. */
	env?: string;
	/**
	 * Publisher signer for `sui client test-publish`. Imported into the
	 * container's CLI keystore via `sui keytool import` and then switched to
	 * via `sui client switch --address`, so any object the published package
	 * transfers to `ctx.sender()` (e.g. DeepBook's `DeepbookAdminCap`) ends
	 * up owned by this account — not the CLI's auto-generated default.
	 *
	 * Must be a `Keypair` (typed as `Signer` for ergonomics) — the helper
	 * exports the bech32 secret via `getSecretKey()` and pipes it into the
	 * in-container `sui keytool import`. Hardware/remote signers
	 * (Ledger/KMS) can't satisfy this contract; declare a localnet-only
	 * factory (`generatedKeypair()`) for the publisher account.
	 */
	publisher: Signer;
	prior?: ImportedPackageCacheEntry;
	/** Override the git clone URL when building the upstream-source
	 * image. Plumbed through to `ensureUpstreamSourceImage`. Ignored when
	 * `localPath` is set. */
	gitUrl?: string | ((repo: string, rev: string) => string);
	/** Use this on-host directory as the source tree instead of cloning
	 * from a git host. The directory is copied into the sui container at
	 * `<CONTAINER_IMPORT_PATH>/<alias>` so the env-inject + publish
	 * commands run against an isolated copy (no mutation of the host
	 * tree). The git-rev cache is bypassed when set; rebuilding on every
	 * cycle is the trade-off for live-edit. */
	localPath?: string;
	/** Route docker's combined stdout/stderr (image fetch, publish, etc.)
	 * through the supervisor's status renderer. Threaded from
	 * `ctx.appendLog` at the action's `run` site. */
	appendLog?: (line: string) => void;
}

interface ImportMovePackageResult {
	packageId: string;
	captured: Record<string, string>;
	deps: Record<string, string>;
	sourceDigest: string;
	digest?: string;
	cacheHit: boolean;
}

export async function importMovePackage(
	opts: ImportMovePackageOptions,
): Promise<ImportMovePackageResult> {
	const { containerName, repo, rev, subdir, alias, capture, chainId, prior } = opts;
	const env = opts.env ?? 'localnet';

	// Local-source mode bypasses the git-rev cache — the on-host tree is
	// the live source of truth. Cycle-time changes the user makes to
	// their checkout are picked up by the file watcher (`watches:` on
	// the build action) and re-trigger import.
	if (
		opts.localPath === undefined &&
		prior !== undefined &&
		prior.sourceDigest === rev &&
		prior.chainId === chainId
	) {
		return {
			packageId: prior.packageId,
			captured: prior.captured,
			deps: prior.deps,
			sourceDigest: rev,
			cacheHit: true,
		};
	}

	// Source-tree provisioning. Two modes:
	//   - localPath: copy the on-host tree into a tmp dir (don't mutate
	//     the user's checkout when we env-inject Move.toml).
	//   - default: build (or reuse) the content-addressed source image,
	//     extract its `/src` to a tmp dir.
	const checkoutDir = mkdtempSync(join(tmpdir(), 'devstack-import-'));
	try {
		if (opts.localPath !== undefined) {
			if (!existsSync(opts.localPath)) {
				throw new Error(`importMovePackage: localPath ${opts.localPath} does not exist`);
			}
			// Copy the on-host tree into the tmp dir. `-RP` (R = recursive,
			// P = preserve symlinks without following) so a stray symlink
			// inside the source tree doesn't ferry contents from outside
			// `localPath` into the build container — `cp -R` follows by
			// default, which would let `sources/keystore -> /etc/ssh` etc.
			// silently be copied in.
			const cpHost = spawnSync('cp', ['-RP', `${opts.localPath}/.`, checkoutDir]);
			if (cpHost.status !== 0) {
				throw new Error(
					`importMovePackage: failed to copy localPath ${opts.localPath}: ${cpHost.stderr.toString()}`,
				);
			}
		} else {
			const { imageTag } = await ensureUpstreamSourceImage({
				repo,
				rev,
				gitUrl: opts.gitUrl,
				appendLog: opts.appendLog,
			});
			await extractUpstreamSource({ imageTag, destDir: checkoutDir });
		}
		const packagePath = join(checkoutDir, subdir);
		if (!existsSync(packagePath)) {
			const sourceLabel =
				opts.localPath !== undefined
					? `localPath ${opts.localPath}`
					: `${repo}@${rev.slice(0, 12)}`;
			throw new Error(`importMovePackage: subdir "${subdir}" not found under ${sourceLabel}`);
		}

		const containerRepoPath = `${CONTAINER_IMPORT_PATH}/${alias}`;
		dockerExec(containerName, ['rm', '-rf', containerRepoPath]);
		dockerExec(containerName, ['mkdir', '-p', containerRepoPath]);
		const cp = spawnSync('docker', [
			'cp',
			`${checkoutDir}/.`,
			`${containerName}:${containerRepoPath}/`,
		]);
		if (cp.status !== 0) {
			throw new Error(`importMovePackage: docker cp failed: ${cp.stderr.toString()}`);
		}

		const containerPkgPath = `${containerRepoPath}/${subdir}`;
		const pubFilePath = `${containerRepoPath}/Pub.${env}.toml`;

		// Sui's `test-publish --build-env <env>` checks the package's declared
		// environments before resolving deps. Packages whose Move.toml lacks an
		// `[environments]` block reject `--build-env localnet` with "Package X
		// does not declare a `localnet` environment". The stub append is a
		// no-op at publish time; the resolver just needs the name to exist.
		// Pass `containerPkgPath` and `env` as positional args via `sh -c
		// '<script>' sh "$1" "$2"` — keeps caller-supplied subdir/env values
		// off the shell command line even with the upstream config validator.
		const envInjectScript =
			'if ! grep -q "^\\[environments\\]" "$1/Move.toml"; then ' +
			'printf "\\n[environments]\\n%s = \\"0000\\"\\n" "$2" >> "$1/Move.toml"; ' +
			'fi';
		dockerExec(containerName, [
			'sh',
			'-c',
			envInjectScript,
			'sh',
			containerPkgPath,
			env,
		]);

		// Persistent-genesis bootstrap (`sui genesis -f --with-faucet` in the
		// entrypoint) creates an env named `localnet` pointing at
		// 127.0.0.1:9000. Switch to it so test-publish lands on our localnet
		// RPC instead of whatever happens to be active. `switch` is
		// idempotent.
		dockerExec(containerName, ['sui', 'client', 'switch', '--env', 'localnet']);

		// Import publisher's keypair into the container's CLI keystore and make
		// it active. Without this, test-publish signs with the CLI's auto-
		// generated default address — and any object the published package
		// transfers to `ctx.sender()` (e.g. deepbook's `DeepbookAdminCap`)
		// becomes inaccessible to plugin-registered accounts. `keytool import`
		// is idempotent (no-op if the key already lives in the keystore).
		if (!(opts.publisher instanceof Keypair)) {
			throw new Error(
				'importMovePackage: publisher must be a Keypair-shaped Signer (the helper imports the bech32 secret into the in-container CLI keystore). Hardware/remote signers are unsupported here.',
			);
		}
		const publisherSecretKey = opts.publisher.getSecretKey();
		const publisherAddress = opts.publisher.toSuiAddress();
		// Pipe the secret via stdin instead of interpolating into the shell
		// command line — argv strings are visible to anyone with `docker
		// exec` to the container during the ~2s import window (`/proc/<pid>
		// /cmdline`, `ps`). The localnet container is the user's, so the
		// threat is small, but argv-as-secret is a habit worth not picking up.
		dockerExecWithInput(
			containerName,
			['sh', '-c', 'sui keytool import "$(cat)" ed25519 2>&1 | tail -1'],
			publisherSecretKey,
		);
		dockerExec(containerName, ['sui', 'client', 'switch', '--address', publisherAddress]);

		// Faucet the publisher address — `sui client test-publish` signs with
		// the active address, and we need 5 SUI of gas.
		dockerExec(containerName, ['sui', 'client', 'faucet']);

		// Stderr is captured (not piped to /dev/null in-container) so failures
		// surface a real diagnostic. RUST_LOG=error keeps the sui CLI's
		// tracing-INFO output off stdout so the JSON parser at the bottom
		// gets a clean buffer. Caller-supplied values (containerPkgPath
		// derived from `subdir`, `env`, `pubFilePath`) are passed as
		// positional args to keep them off the shell command line.
		const publishScript =
			'cd "$1" && ' +
			'sui client test-publish ' +
			'--build-env "$2" ' +
			'--pubfile-path "$3" ' +
			'--with-unpublished-dependencies ' +
			'--gas-budget 5000000000 ' +
			'--json';
		const publish = spawnSync(
			'docker',
			[
				'exec',
				'-e',
				'RUST_LOG=error',
				containerName,
				'sh',
				'-c',
				publishScript,
				'sh',
				containerPkgPath,
				env,
				pubFilePath,
			],
			{ encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
		);
		if (publish.status !== 0) {
			throw new Error(
				`importMovePackage: sui client test-publish failed for ${alias} (exit ${publish.status})\nstdout:\n${publish.stdout.slice(-2000)}\nstderr:\n${publish.stderr.slice(-2000)}`,
			);
		}

		const jsonStart = publish.stdout.indexOf('{');
		if (jsonStart === -1) {
			throw new Error(
				`importMovePackage: no JSON in test-publish output for ${alias}.\n${publish.stdout}`,
			);
		}
		type PublishResultJson = {
			digest: string;
			objectChanges?: Array<{
				type: string;
				packageId?: string;
				objectType?: string;
				objectId?: string;
				modules?: string[];
			}>;
		};
		const result = JSON.parse(publish.stdout.slice(jsonStart)) as PublishResultJson;

		const changes = result.objectChanges ?? [];
		// `--with-unpublished-dependencies` may produce multiple `published`
		// changes (one per dep). Deps publish first, the user's package
		// publishes last — so the last `published` change is our target.
		const publishedChanges = changes.filter(
			(c): c is { type: 'published'; packageId: string; modules?: string[] } =>
				c.type === 'published' && typeof c.packageId === 'string',
		);
		const target = publishedChanges[publishedChanges.length - 1];
		if (target === undefined) {
			throw new Error(`importMovePackage: no "published" change in result for ${alias}`);
		}

		// Auto-published deps (everything except the target), keyed by their
		// first module name. Lets the frontend derive coin types like
		// `<deepCoinPkgId>::deep::DEEP` from the manifest's deps map.
		const deps: Record<string, string> = {};
		for (let i = 0; i < publishedChanges.length - 1; i++) {
			const change = publishedChanges[i];
			if (change === undefined) continue;
			const moduleName = change.modules?.[0];
			if (moduleName !== undefined) deps[moduleName] = change.packageId;
		}

		const captured: Record<string, string> = {};
		for (const [manifestKey, typeFilter] of Object.entries(capture ?? {})) {
			const found = changes.find(
				(c) =>
					c.type === 'created' &&
					c.objectType !== undefined &&
					objectTypeMatchesFilter(c.objectType, typeFilter),
			);
			if (found?.objectId !== undefined) captured[manifestKey] = found.objectId;
		}

		return {
			packageId: target.packageId,
			captured,
			deps,
			sourceDigest: rev,
			digest: result.digest,
			cacheHit: false,
		};
	} finally {
		rmSync(checkoutDir, { recursive: true, force: true });
	}
}

function dockerExec(containerName: string, argv: string[]): void {
	const result = spawnSync('docker', ['exec', containerName, ...argv], { encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(
			`importMovePackage: docker exec ${argv.join(' ')} failed (exit ${result.status}): ${result.stderr}`,
		);
	}
}

function dockerExecWithInput(containerName: string, argv: string[], stdin: string): void {
	const result = spawnSync('docker', ['exec', '-i', containerName, ...argv], {
		encoding: 'utf8',
		input: stdin,
	});
	if (result.status !== 0) {
		// `argv` is the safe shape (no secret interpolation); stderr is the
		// real diagnostic. Don't include `stdin` in the error to avoid
		// leaking the secret into logs.
		throw new Error(
			`importMovePackage: docker exec ${argv.join(' ')} failed (exit ${result.status}): ${result.stderr}`,
		);
	}
}
