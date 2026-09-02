import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const BETA_TAG = 'beta';
export const LATEST_TAG = 'latest';
export const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

export function getWorkspacePackages(repositoryRoot, { publicOnly = false } = {}) {
	return readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const directory = join(repositoryRoot, 'packages', entry.name);
			const manifestPath = join(directory, 'package.json');
			const manifest = readManifest(manifestPath);

			return { directory, manifest, manifestPath };
		})
		.filter(({ manifest }) => manifest.name && (!publicOnly || !manifest.private));
}

export function readManifest(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

export async function getPackageMetadata(name) {
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
	if (response.status === 404) return {};
	if (!response.ok) {
		throw new Error(
			`Failed to query npm metadata for ${name}: ${response.status} ${response.statusText}`,
		);
	}

	return response.json();
}

export async function getPublishedVersions(name) {
	return Object.keys((await getPackageMetadata(name)).versions ?? {});
}

export function getReleaseChannel(manifest) {
	const tag = manifest.publishConfig?.tag ?? LATEST_TAG;
	if (tag !== LATEST_TAG && tag !== BETA_TAG) {
		throw new Error(`${manifest.name} has unsupported publishConfig.tag ${JSON.stringify(tag)}`);
	}

	return tag;
}

export function getNextBetaVersion({ targetVersion, currentVersion, publishedVersions }) {
	const betaPattern = new RegExp(`^${escapeRegExp(targetVersion)}-beta\\.(\\d+)$`);
	const betaNumbers = publishedVersions
		.map((version) => betaPattern.exec(version)?.[1])
		.filter((version) => version !== undefined)
		.map(Number);
	const currentBeta = betaPattern.exec(currentVersion)?.[1];

	if (currentBeta !== undefined) betaNumbers.push(Number(currentBeta));

	const nextBeta = betaNumbers.length === 0 ? 0 : Math.max(...betaNumbers) + 1;
	return `${targetVersion}-beta.${nextBeta}`;
}

export function validateVersionForChannel(name, version, channel) {
	if (channel === BETA_TAG && !/-beta\.\d+$/.test(version)) {
		throw new Error(`${name}@${version} is on the beta channel without a beta version`);
	}
	if (channel === LATEST_TAG && version.includes('-')) {
		throw new Error(`${name}@${version} is a prerelease on the latest channel`);
	}
}

export function getPublishArguments(manifest) {
	return [
		'publish',
		'--tag',
		getReleaseChannel(manifest),
		'--access',
		manifest.publishConfig?.access ?? 'public',
		'--no-git-checks',
	];
}

export function dependencyWouldUseVersion(range, version) {
	return ['workspace:*', 'workspace:^', 'workspace:~'].includes(range) || range.includes(version);
}

export function replaceDependencyVersion(range, stableVersion, betaVersion) {
	return range.includes(stableVersion) ? range.replace(stableVersion, betaVersion) : range;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
