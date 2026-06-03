// Fetch the upstream DeepBook (deepbookv3) Move sources at a pinned revision.
//
// ~9k lines of third-party Move (the `token`/`deepbook`/`dusdc` packages from
// https://github.com/MystenLabs/deepbookv3) are NOT vendored in git. Instead,
// this script materializes them on demand into
// `src/plugins/deepbook/bootstrap-assets/move/deepbookv3/` so that:
//   - `deepbook({ mode: 'local' })` can publish them during `devstack apply`,
//   - `build:deepbook-assets` can copy them into the shipped `move-assets/`.
//
// The small sandbox-Pyth mock (`deepbook-sandbox/pyth`) is *vendored* (committed)
// alongside this fetched tree — it is not fetched here.
//
// Behaviour:
//   - Shallow-fetches exactly DEEPBOOKV3_REV (a 40-char SHA), copies the three
//     package dirs (sources + Move.toml; deepbook's README too), EXCLUDING
//     tests/, build/, package_summaries/, Move.lock and Published.toml.
//   - Rewrites deepbook's `token` dependency from the upstream git ref to a
//     `local = "../token"` path so the trees publish together offline.
//   - Idempotent + cached: skips work if the tree already exists with a marker
//     file (`.deepbookv3-rev`) recording the pinned SHA. Pass `--force` to
//     re-fetch.
//   - Fails with a clear message if offline / the clone fails.
//
// PROVENANCE: DEEPBOOKV3_REV reproduces the previously-vendored sources exactly
// (verified by a byte-for-byte diff of token/deepbook/dusdc `sources/` against
// the upstream packages at this rev). It is the parent of the upstream
// `v8.0.0` "sync deepbook + deepbook_margin Move code" commit, which is the
// last rev before upstream added the DeepbookCorePauseCap / max_stake_required
// / new_with_custom_owner_caps_v2 surface. Bump deliberately, re-diffing the
// capture-key structs (registry::Registry, registry::DeepbookAdminCap,
// deep::ProtectedTreasury) and re-running the deepbook plugin tests.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEEPBOOKV3_REPO = 'https://github.com/MystenLabs/deepbookv3.git';
const DEEPBOOKV3_REV = '378f71bb5bcbf93d384cb351eab331a6ac03eaf1';

// The three upstream packages we publish locally. `upstream` is the path under
// the repo's `packages/` dir; `dest` is the dir under our deepbookv3 root.
const PACKAGES = [
	{ upstream: 'token', dest: 'token' },
	{ upstream: 'deepbook', dest: 'deepbook' },
	{ upstream: 'dusdc', dest: 'dusdc' },
];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const deepbookv3Root = join(
	packageRoot,
	'src',
	'plugins',
	'deepbook',
	'bootstrap-assets',
	'move',
	'deepbookv3',
);
const markerFile = join(deepbookv3Root, '.deepbookv3-rev');

const force = process.argv.includes('--force');

const log = (msg) => {
	// eslint-disable-next-line no-console
	console.log(`[fetch:deepbook-move] ${msg}`);
};

const git = (args, cwd) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// Skip Move build artifacts / locks / publish records that must never ship.
const isExcluded = (src) =>
	src.endsWith('Move.lock') ||
	src.endsWith('Published.toml') ||
	src.includes(`${join('', 'build', '')}`) ||
	src.includes(`${join('', 'package_summaries', '')}`) ||
	src.includes(`${join('', 'tests', '')}`);

// Rewrite deepbook's upstream git `token` dependency to a local path so the
// fetched `token` package publishes alongside it (offline, deterministic).
const localizeTokenDep = (moveTomlPath) => {
	const original = readFileSync(moveTomlPath, 'utf8');
	const rewritten = original.replace(
		/^token[ \t]*=[ \t]*\{[^}]*\}[ \t]*$/m,
		'token = { local = "../token" }',
	);
	if (rewritten === original) {
		throw new Error(
			`fetch:deepbook-move: expected a \`token = { ... }\` dependency in ${moveTomlPath} to localize, ` +
				`but none matched — upstream Move.toml layout may have changed. Re-pin and update this script.`,
		);
	}
	writeFileSync(moveTomlPath, rewritten);
};

const alreadyFetched = () => {
	if (!existsSync(markerFile)) return false;
	const pinned = readFileSync(markerFile, 'utf8').trim();
	if (pinned !== DEEPBOOKV3_REV) return false;
	// Sanity-check the tree is actually present (a deleted dir leaves no marker,
	// but a partial wipe could).
	return existsSync(join(deepbookv3Root, 'deepbook', 'Move.toml'));
};

const main = () => {
	if (!force && alreadyFetched()) {
		log(`up to date (rev ${DEEPBOOKV3_REV}); use --force to re-fetch`);
		return;
	}

	let tmpDir;
	try {
		tmpDir = execFileSync('mktemp', ['-d', '-t', 'deepbookv3-fetch.XXXXXX'])
			.toString()
			.trim();
	} catch (cause) {
		throw new Error(`fetch:deepbook-move: could not create temp dir: ${cause?.message ?? cause}`);
	}

	try {
		log(`fetching deepbookv3 @ ${DEEPBOOKV3_REV} (shallow)`);
		try {
			git(['init', '--quiet'], tmpDir);
			git(['remote', 'add', 'origin', DEEPBOOKV3_REPO], tmpDir);
			// Fetch exactly the pinned commit, depth 1. Works on GitHub (allows
			// fetching by SHA) and avoids pulling the full history.
			git(['fetch', '--depth', '1', '--quiet', 'origin', DEEPBOOKV3_REV], tmpDir);
			git(['checkout', '--quiet', 'FETCH_HEAD'], tmpDir);
		} catch (cause) {
			const detail = cause?.stderr?.toString?.() ?? cause?.message ?? String(cause);
			throw new Error(
				`fetch:deepbook-move: could not fetch ${DEEPBOOKV3_REPO} @ ${DEEPBOOKV3_REV}.\n` +
					`Network access to github.com is required to build this package from a clean checkout.\n` +
					`Underlying error:\n${detail}`,
			);
		}

		// Materialize into a staging dir first, then swap, so a failed fetch never
		// leaves a half-written tree behind the marker.
		const staging = join(tmpDir, '__staged_deepbookv3');
		mkdirSync(staging, { recursive: true });

		for (const { upstream, dest } of PACKAGES) {
			const srcPkg = join(tmpDir, 'packages', upstream);
			const destPkg = join(staging, dest);
			if (!existsSync(join(srcPkg, 'Move.toml'))) {
				throw new Error(
					`fetch:deepbook-move: upstream package 'packages/${upstream}' missing at the pinned rev — ` +
						`the repo layout may have changed. Re-pin and update PACKAGES.`,
				);
			}
			cpSync(srcPkg, destPkg, { recursive: true, filter: (src) => !isExcluded(src) });
		}

		// Apply the one local Move.toml customization (deepbook → local token dep).
		localizeTokenDep(join(staging, 'deepbook', 'Move.toml'));

		// Swap into place atomically-ish: wipe the old tree, move staging in.
		rmSync(deepbookv3Root, { recursive: true, force: true });
		mkdirSync(dirname(deepbookv3Root), { recursive: true });
		cpSync(staging, deepbookv3Root, { recursive: true });
		writeFileSync(markerFile, `${DEEPBOOKV3_REV}\n`);

		log(`done → ${deepbookv3Root}`);
	} finally {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	}
};

main();
