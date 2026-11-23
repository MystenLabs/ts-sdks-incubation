#!/usr/bin/env node

// Validates each public package's npm trusted-publishing config without publishing anything.
// A dry-run publish performs the OIDC token exchange, which counts as using the config. New configs
// have to be used within 48 hours of being created or they expire. For a version that's already on
// npm, the dry run then stops at npm's version check, so only the exchange result matters here.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPublishArguments, getWorkspacePackages } from './release-channels.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failed = [];

for (const { directory, manifest } of getWorkspacePackages(repositoryRoot, { publicOnly: true })) {
	const result = spawnSync(
		'pnpm',
		[...getPublishArguments(manifest), '--dry-run', '--ignore-scripts'],
		{
			cwd: directory,
			encoding: 'utf8',
			env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'verbose' },
		},
	);
	const output = `${result.stdout}${result.stderr}`;

	if (output.includes('oidc Successfully retrieved and set token')) {
		console.log(`ok      ${manifest.name}`);
		continue;
	}

	failed.push(manifest.name);
	console.log(`FAILED  ${manifest.name}`);
	for (const line of output.split('\n')) {
		if (line.includes(' oidc ') || line.includes('npm error')) console.log(`        ${line}`);
	}
}

if (failed.length > 0) {
	console.error(`\nTrusted-publishing token exchange failed for: ${failed.join(', ')}`);
	process.exitCode = 1;
}
