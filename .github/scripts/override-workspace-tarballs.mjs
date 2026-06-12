// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// Point a scaffolded app's @mysten-incubation/* dependencies at freshly
// packed workspace tarballs so CI installs the CURRENT tree instead of
// the published registry versions. Same packed-tarball mechanism as
// `packages/devstack/scripts/packed-consumer-typecheck.mjs`
// (`smoke:pack-consumer`), generalized to the three packages a
// scaffolded app consumes and applied via `pnpm.overrides` so direct
// AND transitive resolutions hit the tarballs.
//
// Usage: node override-workspace-tarballs.mjs <app-dir> <tarball-dir>
//   <app-dir>      a scaffolded app (its package.json is rewritten)
//   <tarball-dir>  directory holding the `pnpm pack` output for
//                  devstack, dev-wallet, and tsconfig

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [appDir, tarballDir] = process.argv.slice(2);
if (appDir === undefined || tarballDir === undefined) {
	console.error('usage: override-workspace-tarballs.mjs <app-dir> <tarball-dir>');
	process.exit(1);
}

const tarballs = readdirSync(tarballDir).filter((file) => file.endsWith('.tgz'));

// `pnpm pack` names scoped tarballs `<scope>-<name>-<version>.tgz`.
// Prefix-match so the packed versions never leak into CI config. The
// `mysten-incubation-devstack-` prefix cannot collide with the
// dev-wallet tarball, and create-devstack-app itself is never packed
// into this directory.
const specFor = (packageName) => {
	const filePrefix = `${packageName.replace('@', '').replace('/', '-')}-`;
	const hit = tarballs.find((file) => file.startsWith(filePrefix));
	if (hit === undefined) {
		throw new Error(`no packed tarball for ${packageName} (${filePrefix}*.tgz) in ${tarballDir}`);
	}
	return `file:${resolve(tarballDir, hit)}`;
};

const overrides = {
	'@mysten-incubation/devstack': specFor('@mysten-incubation/devstack'),
	'@mysten-incubation/dev-wallet': specFor('@mysten-incubation/dev-wallet'),
	'@mysten-incubation/tsconfig': specFor('@mysten-incubation/tsconfig'),
};

const pkgPath = join(appDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.pnpm = { ...pkg.pnpm, overrides: { ...pkg.pnpm?.overrides, ...overrides } };
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, '\t')}\n`);
console.log(`pointed @mysten-incubation deps at packed tarballs in ${pkgPath}`);
