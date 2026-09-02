#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BETA_TAG,
	DEPENDENCY_FIELDS,
	dependencyWouldUseVersion,
	getNextBetaVersion,
	getPublishedVersions,
	getReleaseChannel,
	getWorkspacePackages,
	readManifest,
	replaceDependencyVersion,
} from './release-channels.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repositoryRoot);

if (existsSync(join(repositoryRoot, '.changeset', 'pre.json'))) {
	throw new Error(
		'Repository-wide Changesets prerelease mode cannot be combined with package channels',
	);
}

const packages = getWorkspacePackages(repositoryRoot);
const packagesByName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));

for (const { manifest } of packages) {
	getReleaseChannel(manifest);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'changesets-version-'));
const statusPath = join(temporaryDirectory, 'status.json');

try {
	execFileSync('pnpm', ['changeset', 'status', '--output', statusPath], { stdio: 'inherit' });
	const status = JSON.parse(readFileSync(statusPath, 'utf8'));
	const releasesByName = new Map(status.releases.map((release) => [release.name, release]));
	const betaReleases = status.releases.filter((release) => {
		const pkg = packagesByName.get(release.name);
		return pkg && release.type !== 'none' && getReleaseChannel(pkg.manifest) === BETA_TAG;
	});

	execFileSync('pnpm', ['changeset', 'version'], { stdio: 'inherit' });

	const betaVersions = new Map();
	for (const release of betaReleases) {
		const pkg = packagesByName.get(release.name);
		betaVersions.set(
			release.name,
			getNextBetaVersion({
				targetVersion: release.newVersion,
				currentVersion: pkg.manifest.version,
				publishedVersions: await getPublishedVersions(release.name),
			}),
		);
	}

	for (const release of status.releases) {
		const pkg = packagesByName.get(release.name);
		if (!pkg || pkg.manifest.private || getReleaseChannel(pkg.manifest) === BETA_TAG) continue;

		const manifest = readManifest(pkg.manifestPath);
		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
				const betaVersion = betaVersions.get(dependency);
				if (
					betaVersion &&
					dependencyWouldUseVersion(range, releasesByName.get(dependency).newVersion)
				) {
					throw new Error(
						`${release.name} is a stable release that would depend on beta release ${dependency}@${betaVersion}`,
					);
				}
			}
		}
	}

	for (const [name, betaVersion] of betaVersions) {
		const pkg = packagesByName.get(name);
		const release = releasesByName.get(name);
		const manifest = readManifest(pkg.manifestPath);

		if (manifest.version !== release.newVersion) {
			throw new Error(`Expected Changesets to version ${name} to ${release.newVersion}`);
		}

		manifest.version = betaVersion;
		writeManifest(pkg.manifestPath, manifest);

		const changelogPath = join(pkg.directory, 'CHANGELOG.md');
		if (existsSync(changelogPath)) {
			const changelog = readFileSync(changelogPath, 'utf8');
			const heading = `## ${release.newVersion}`;
			if (!changelog.includes(heading)) {
				throw new Error(`Could not find ${heading} in ${name}'s changelog`);
			}
			writeFileSync(changelogPath, changelog.replace(heading, `## ${betaVersion}`));
		}
	}

	for (const pkg of packages) {
		const manifest = readManifest(pkg.manifestPath);
		let changed = false;

		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
				const betaVersion = betaVersions.get(dependency);
				const stableVersion = releasesByName.get(dependency)?.newVersion;
				if (!betaVersion || !stableVersion || !range.includes(stableVersion)) continue;

				manifest[field][dependency] = replaceDependencyVersion(range, stableVersion, betaVersion);
				changed = true;
			}
		}

		if (changed) writeManifest(pkg.manifestPath, manifest);
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

function writeManifest(path, manifest) {
	writeFileSync(path, `${JSON.stringify(manifest, null, '\t')}\n`);
}
