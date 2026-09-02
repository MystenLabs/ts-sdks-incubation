#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	getPackageMetadata,
	getPublishArguments,
	getReleaseChannel,
	getWorkspacePackages,
	validateVersionForChannel,
} from './release-channels.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

process.chdir(repositoryRoot);

const packages = getWorkspacePackages(repositoryRoot, { publicOnly: true });

for (const { directory, manifest } of packages) {
	const tag = getReleaseChannel(manifest);
	validateVersionForChannel(manifest.name, manifest.version, tag);

	const metadata = await getPackageMetadata(manifest.name);
	if (metadata.versions && Object.hasOwn(metadata.versions, manifest.version)) continue;

	console.log(`Publishing ${manifest.name}@${manifest.version} to ${tag}`);
	if (dryRun) continue;

	execFileSync('pnpm', getPublishArguments(manifest), { cwd: directory, stdio: 'inherit' });
}

if (!dryRun) {
	// Match `changeset publish` behavior so changesets/action can push package tags and create releases.
	execFileSync('pnpm', ['changeset', 'tag'], { stdio: 'inherit' });
}
