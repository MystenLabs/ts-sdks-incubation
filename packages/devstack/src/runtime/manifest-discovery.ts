// Process-side manifest discovery. Used by test harnesses (vitest
// globalSetup, playwright account-pool fixture) that run inside an app's
// process tree and need to find the manifest written by `devstack apply`
// without being told the appDir explicitly.
//
// The supervisor / one-shot driver knows its appDir up front and uses
// `manifest-reader.ts` directly; this module is the cross-process
// discovery layer that both test harnesses share so their lookup
// precedence stays in lockstep.
//
// Search order (precedence, highest first):
//   1. opts.explicitPath — caller-supplied (e.g. CI runner).
//   2. process.env.DEVSTACK_MANIFEST_PATH — cross-process channel.
//   3. Walk up from `cwd` looking for a `devstack.config.ts`; when found,
//      read `<dir>/.devstack/stacks/<stack>/manifest.json`.
//
// Throws when no readable manifest is found, with an actionable hint.
// Consumers that tolerate a missing manifest should wrap the call in a
// try/catch — there's no "soft" variant by design, so the caller's intent
// (tolerant vs. required) is visible at the call site.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { Manifest } from './manifest-types.js';

export interface ManifestDiscoveryResult {
	/** Absolute path the manifest was loaded from. */
	path: string;
	manifest: Manifest;
}

export interface FindManifestOptions {
	/**
	 * Override the cwd-based search. When set, takes precedence over env vars
	 * and the search-from-cwd fallback.
	 */
	explicitPath?: string;
	/**
	 * Cwd to start the search from. Defaults to `process.cwd()`.
	 */
	cwd?: string;
	/**
	 * Stack to use when no manifest path is explicit. Defaults to
	 * `process.env.DEVSTACK_STACK ?? 'main'`.
	 */
	stack?: string;
}

/** Soft cap on manifest file size — mirrors `manifest-reader.ts`. Real
 * manifests are <100KB; orders-of-magnitude larger means corruption or a
 * hostile committed file. Refuse rather than blocking the event loop on a
 * multi-GB JSON.parse. */
const MANIFEST_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Find the active devstack manifest for the current process. Returns the
 * parsed Manifest plus the path it was loaded from. Throws when no manifest
 * is found, with the list of paths attempted and an actionable hint.
 */
export function findManifestForCwd(opts: FindManifestOptions = {}): ManifestDiscoveryResult {
	const stack = nonEmpty(opts.stack) ?? nonEmpty(process.env.DEVSTACK_STACK) ?? 'main';
	const cwd = opts.cwd ?? process.cwd();

	const attempted: string[] = [];

	// 1. Caller-supplied explicit path.
	if (opts.explicitPath !== undefined && opts.explicitPath.length > 0) {
		const path = isAbsolute(opts.explicitPath)
			? opts.explicitPath
			: resolve(cwd, opts.explicitPath);
		attempted.push(path);
		const result = tryRead(path);
		if (result !== null) return result;
	}

	// 2. Env-var override.
	const envPath = process.env.DEVSTACK_MANIFEST_PATH;
	if (envPath !== undefined && envPath.length > 0) {
		const path = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
		attempted.push(path);
		const result = tryRead(path);
		if (result !== null) return result;
	}

	// 3. Walk up from cwd until we hit a `devstack.config.ts`. Read the
	// manifest from that dir's `.devstack/stacks/<stack>/manifest.json`.
	const appDir = findAppDir(cwd);
	if (appDir !== null) {
		const path = resolve(appDir, '.devstack', 'stacks', stack, 'manifest.json');
		attempted.push(path);
		const result = tryRead(path);
		if (result !== null) return result;
	} else {
		// Surface the walked range so the error message is actionable
		// (lets the user see we never found a `devstack.config.ts`).
		attempted.push(`<no devstack.config.ts found walking up from ${cwd}>`);
	}

	throw new Error(
		`no devstack manifest found.\n` +
			`  Looked at:\n${attempted.map((p) => `    - ${p}`).join('\n')}\n` +
			`  Run \`devstack apply\` (in your app dir) first, or set DEVSTACK_MANIFEST_PATH explicitly.`,
	);
}

function tryRead(path: string): ManifestDiscoveryResult | null {
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	if (stat.size > MANIFEST_MAX_BYTES) {
		throw new Error(
			`findManifestForCwd: ${path} is ${stat.size} bytes (cap ${MANIFEST_MAX_BYTES}). ` +
				'Real manifests are <100KB. Run `devstack wipe --yes` if the file ballooned by mistake.',
		);
	}
	const raw = readFileSync(path, 'utf8');
	let manifest: Manifest;
	try {
		manifest = JSON.parse(raw) as Manifest;
	} catch (err) {
		throw new Error(
			`findManifestForCwd: ${path} is corrupt (${err instanceof Error ? err.message : 'invalid JSON'}). ` +
				'Run `devstack wipe --yes` to wipe the stack and regenerate.',
		);
	}
	return { path, manifest };
}

function nonEmpty(s: string | undefined): string | undefined {
	if (s === undefined || s.length === 0) return undefined;
	return s;
}

/** Walk up from `start` looking for a `devstack.config.ts`. Returns the
 * first dir that contains it, or null if we hit the filesystem root.
 *
 * Convention: walk up from `cwd` until a devstack.config.ts is found. In
 * a monorepo with multiple apps (`apps/<your-app>`), the first app dir
 * encountered wins. Run tests from inside the target app's dir, OR set
 * DEVSTACK_MANIFEST_PATH explicitly to disambiguate. Running from a
 * parent dir above any app walks past the monorepo root and fails
 * loudly with "no devstack manifest found"; that's intentional — there's
 * no way to guess the user's intent. */
function findAppDir(start: string): string | null {
	let dir = resolve(start);
	// Bound the walk to avoid surprising behaviour on weird filesystems.
	// 64 levels is far deeper than any realistic monorepo.
	for (let i = 0; i < 64; i++) {
		if (existsSync(resolve(dir, 'devstack.config.ts'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
