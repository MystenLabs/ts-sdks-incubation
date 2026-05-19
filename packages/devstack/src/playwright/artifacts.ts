// Spec-side artifact loaders: typed manifest + per-account keypairs.
//
// Most playwright specs only ever drive the UI — `connectAs(page, 'alice')`
// + page assertions are enough. A small slice (notably arena's
// `connect-four.spec.ts`) needs to escape the UI and submit transactions
// directly via the SDK, which means reaching into the on-disk artifacts
// the supervisor writes:
//
//   - `.devstack/stacks/<stack>/manifest.json`       (services + packages + addrs)
//   - `.devstack/stacks/<stack>/runtime/accounts/<name>.key`   (bech32 secret)
//
// Hand-rolling these reads requires repeating four pieces of folklore
// per spec: (1) where the state dir lives, (2) how the `DEVSTACK_STACK`
// env var fits in, (3) the manifest's JSON shape, (4) how
// `decodeSuiPrivateKey` + `Ed25519Keypair.fromSecretKey` compose. This
// module folds all four into one acquisition site:
//
//   import { loadStackManifest, loadStackKeypair }
//     from '@mysten-incubation/devstack/playwright';
//
//   const manifest = loadStackManifest();
//   const alice = loadStackKeypair('alice');
//
// Synchronous on purpose — Playwright specs are happy to do top-level
// `const` inits, and the filesystem reads are cheap stat-then-read ops.
// Both helpers throw a descriptive error on miss with the same
// "run `devstack up` first" tone the rest of the playwright subpath uses.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { discoverManifestPath } from '../runtime/discover-manifest.js';
import type { Manifest } from '../runtime/manifest-schema.js';

export interface LoadStackManifestOptions {
	/** Caller-supplied override path. Bypasses the walk-up but is itself
	 *  still validated to exist. Lower precedence than the
	 *  `DEVSTACK_MANIFEST_PATH` env var (same precedence ladder as the
	 *  shared `discoverManifestPath` helper). */
	readonly manifestPath?: string;
	/** Starting directory for the walk-up. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Stack name. Defaults to `process.env.DEVSTACK_STACK ?? 'main'`. */
	readonly stack?: string;
}

/**
 * Locate + parse the devstack manifest for the active stack. Returns
 * the fully-typed `Manifest` shape so specs can navigate
 * `manifest.services.sui.rpc.url`, `manifest.packages.<name>.id`,
 * `manifest.accounts.<name>.address`, `manifest.app.extras.<key>` with
 * full IDE help.
 *
 * Throws a descriptive error if the manifest is missing — same tone as
 * `webServer` / `baseURL`: "run `devstack up` first". The walk-up
 * follows the canonical precedence ladder (see `discoverManifestPath`).
 *
 * Reads sync because the rest of the playwright subpath is sync — keeps
 * specs free to do top-level `const manifest = loadStackManifest()`.
 */
export function loadStackManifest(opts: LoadStackManifestOptions = {}): Manifest {
	const manifestPath = discoverManifestPath({
		override: opts.manifestPath,
		cwd: opts.cwd,
		stack: opts.stack,
		required: true,
	});
	if (manifestPath === undefined) {
		// `required: true` guarantees a throw above, but the type checker
		// can't see that — keep this branch as a defensive guard.
		throw new Error(
			'[devstack/playwright] loadStackManifest: manifest discovery returned undefined',
		);
	}
	const raw = readFileSync(manifestPath, 'utf8');
	return JSON.parse(raw) as Manifest;
}

export interface LoadStackKeypairOptions extends LoadStackManifestOptions {
	/** Directory holding per-account `<name>.key` files. Default:
	 *  derive from `manifestPath`'s parent (the stack root) +
	 *  `runtime/accounts`. Overriding skips the manifest lookup. */
	readonly accountsDir?: string;
}

/**
 * Load the persisted `Ed25519Keypair` for a named devstack account from
 * the supervisor's runtime directory.
 *
 * The supervisor writes each account's bech32 secret key to
 * `<state-dir>/stacks/<stack>/runtime/accounts/<name>.key` after first
 * funding. This helper locates that file (alongside the manifest the
 * `webServer` / `baseURL` helpers already read), reads it, decodes it,
 * and returns an Ed25519Keypair the caller can sign transactions with.
 *
 * Companion to `loadStackManifest`: read addresses + package ids from
 * the manifest, sign transactions with the keypair returned here.
 */
export function loadStackKeypair(name: string, opts: LoadStackKeypairOptions = {}): Ed25519Keypair {
	const accountsDir = opts.accountsDir ?? resolveAccountsDir(opts);
	const keyPath = join(accountsDir, `${name}.key`);
	let raw: string;
	try {
		raw = readFileSync(keyPath, 'utf8');
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') {
			throw new Error(
				`[devstack/playwright] no account key at ${keyPath} ` +
					`for '${name}'. Either the account name is wrong, or the ` +
					`supervisor hasn't funded it yet — run \`devstack up\` ` +
					`(or \`devstack apply\`) first.`,
			);
		}
		throw err;
	}
	return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(raw.trim()).secretKey);
}

function resolveAccountsDir(opts: LoadStackManifestOptions): string {
	// Re-use the manifest's location to derive the stack root, then
	// append the canonical `runtime/accounts` subpath. This piggybacks
	// on the manifest discovery ladder (env var → override → walk-up)
	// without duplicating the resolution logic.
	const manifestPath = discoverManifestPath({
		override: opts.manifestPath,
		cwd: opts.cwd,
		stack: opts.stack,
		required: true,
	});
	if (manifestPath === undefined) {
		throw new Error(
			'[devstack/playwright] loadStackKeypair: manifest discovery returned undefined',
		);
	}
	// `<state-dir>/stacks/<stack>/manifest.json` -> dirname -> stack root.
	return resolve(dirname(manifestPath), 'runtime', 'accounts');
}
