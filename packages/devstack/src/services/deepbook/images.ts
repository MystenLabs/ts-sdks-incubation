// DeepBook indexer + server image pairing table.
//
// R12: indexer image-version and server image-version must match the Move
// source version they were built against. Bumping one without the others
// silently corrupts indexed data. This file pins the table; consumers
// read it via `getDeepbookImages(moveVersion, arch)`.
//
// Each entry maps a Move source version to a pair of pinned Docker image
// digests (one for the indexer Rust binary, one for the server Rust
// binary). Arm64 variants carry `-arm64` suffixes; x86 is unsuffixed.
// Runtime arch detection picks via `process.arch` (R3 mitigation).

export interface DeepbookImagePair {
	/** Indexer image — Rust binary reading checkpoints, writing Postgres. */
	readonly indexer: string;
	/** Server image — Rust binary serving REST API from Postgres. */
	readonly server: string;
}

const ARM64_SUFFIX = '-arm64';

/** Image-pairing table. Add new Move-version entries here in lockstep
 *  with upstream sandbox bumps. Each entry's keys ARE the Move source
 *  version (e.g. `'v7.0.0'`), and the values are images per arch.
 *
 *  Initial entry sourced from
 *  `~/code/deepbook-sandbox/sandbox/docker-compose.yml:106,152,196`. */
export const DEEPBOOK_IMAGES: Record<
	string,
	{ readonly amd64: DeepbookImagePair; readonly arm64: DeepbookImagePair }
> = {
	'v7.0.0': {
		amd64: {
			indexer: 'mysten/deepbookv3-sandbox-indexer:46d846e5',
			server: 'mysten/deepbookv3-sandbox-server:46d846e5',
		},
		arm64: {
			indexer: `mysten/deepbookv3-sandbox-indexer:46d846e5${ARM64_SUFFIX}`,
			server: `mysten/deepbookv3-sandbox-server:46d846e5${ARM64_SUFFIX}`,
		},
	},
};

/** Resolve the indexer + server images for a given Move version at the
 *  current host's architecture. Throws if no entry exists for the version
 *  (consumer must pin a known version OR provide their own image refs). */
export const getDeepbookImages = (
	moveVersion: string,
	arch: NodeJS.Architecture = process.arch as NodeJS.Architecture,
): DeepbookImagePair => {
	const entry = DEEPBOOK_IMAGES[moveVersion];
	if (entry === undefined) {
		throw new Error(
			`DeepBook image pair: no entry for Move version '${moveVersion}'. ` +
				`Known versions: ${Object.keys(DEEPBOOK_IMAGES).join(', ')}. ` +
				`Either pin a known version or pass \`image: { pull: '<tag>' }\` to override.`,
		);
	}
	return arch === 'arm64' ? entry.arm64 : entry.amd64;
};

/** Default Move version pinned by this devstack build. Consumers can
 *  override via `DeepbookIndexer({ moveVersion: 'vX.Y.Z' })` once
 *  additional entries land in `DEEPBOOK_IMAGES`. */
export const DEFAULT_DEEPBOOK_MOVE_VERSION = 'v7.0.0';
