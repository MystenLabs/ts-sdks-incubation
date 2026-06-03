// Snapshot artifact descriptor + metadata schema.
//
// Architecture § Snapshot:
//   "A tar of declared filesystem subtrees, committed container images
//   (one per managed container identified by label tuples), a typed
//   metadata slice (identity-guard contributions + plugin's structured
//   state)."
//
// On-disk layout of one snapshot artifact (under
// `<stackRoot>/snapshots/<snapshotId>/`):
//
//   meta.json              — versioned metadata record, schema-decoded
//   host-tree.tar          — tar of subtrees declared by participants
//   containers/images.tar  — deduplicated Docker save bundle for all
//                            committed managed-container images
//   contributions/<encoded-plugin>.json
//                          — one typed metadata slice per participant
//
// Layout discipline:
//   - `meta.json` is authoritative. Architecture § Snapshotable
//     "Metadata is authoritative": if it's absent or unparseable,
//     restore refuses (no silent partial-restore downgrade).
//   - Anything else missing surfaces as a phase-tagged
//     `SnapshotPartialError` and aborts before any destructive mutation.
//   - The artifact directory itself becomes "complete" only via the
//     stage-and-swap atomic rename — readers never observe a
//     half-written tree.

import { Schema } from 'effect';

import type { Brand } from '../../substrate/brand.ts';
import { versionedDocSchema } from '../../substrate/versioned-doc-schema.ts';

// -----------------------------------------------------------------------------
// File layout — string constants the capture / restore code reaches for
// -----------------------------------------------------------------------------

/** Canonical file / directory names inside one snapshot artifact. */
export const SnapshotLayout = {
	metaFile: 'meta.json',
	hostTreeTar: 'host-tree.tar',
	containersDir: 'containers',
	contributionsDir: 'contributions',
} as const;

export type SnapshotId = Brand<string, 'SnapshotId'>;

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const SNAPSHOT_ID_RULE =
	'snapshot ids must be 1-128 characters matching [A-Za-z0-9][A-Za-z0-9_-]*';

/** Tagged failure for descriptor-layer validation. Carries a discriminator
 *  so downstream phase classifiers can `catchTag` and dispatch on `kind`
 *  without sniffing the message. STYLE_GUIDE §2 rule 5. */
export class SnapshotDescriptorError extends Schema.TaggedErrorClass<SnapshotDescriptorError>()(
	'SnapshotDescriptorError',
	{
		kind: Schema.Literals(['invalid-id', 'invalid-segment']),
		detail: Schema.String,
		value: Schema.String,
	},
) {}

export const isValidSnapshotId = (value: string): boolean =>
	SNAPSHOT_ID_PATTERN.test(value) && isSafeSnapshotPathSegment(value);

export const parseSnapshotId = (value: string): SnapshotId | null =>
	isValidSnapshotId(value) ? (value as SnapshotId) : null;

/** Brand-cast helper for known-valid id literals (primarily test
 *  fixtures). Throws a typed `SnapshotDescriptorError` instance on
 *  violation so any defect surfacing carries the canonical `_tag`
 *  instead of a bare `Error` string-match. */
export const snapshotIdFromString = (value: string): SnapshotId => {
	const parsed = parseSnapshotId(value);
	if (parsed === null) {
		throw new SnapshotDescriptorError({
			kind: 'invalid-id',
			detail: SNAPSHOT_ID_RULE,
			value,
		});
	}
	return parsed;
};

export const isSafeSnapshotPathSegment = (segment: string): boolean =>
	segment.length > 0 &&
	segment !== '.' &&
	segment !== '..' &&
	!segment.includes('/') &&
	!segment.includes('\\') &&
	!segment.includes('\0');

export const isSafeSnapshotRelativePath = (relPath: string): boolean =>
	relPath !== '' &&
	relPath !== '.' &&
	!relPath.startsWith('/') &&
	!relPath.includes('\\') &&
	!relPath.includes('\0') &&
	!relPath.split(/[\\/]+/).includes('..');

export const isRestorableContainerImageName = (imageName: string): boolean =>
	imageName.length > 0 &&
	imageName.trim() === imageName &&
	!/\s/.test(imageName) &&
	!imageName.includes('@') &&
	!imageName.startsWith('sha256:');

const snapshotPathSegment = (kind: string, value: string): string => {
	if (!isSafeSnapshotPathSegment(value)) {
		throw new SnapshotDescriptorError({
			kind: 'invalid-segment',
			detail: `unsafe snapshot ${kind} path segment`,
			value,
		});
	}
	return value;
};

const encodedSnapshotPathSegment = (value: string): string => {
	let hex = '';
	for (const byte of new TextEncoder().encode(value)) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return `p-${hex}`;
};

/** Canonical sub-path for one captured container image. */
export const containerImagePath = (plugin: string, role: string): string =>
	`${SnapshotLayout.containersDir}/${snapshotPathSegment(
		'plugin',
		plugin,
	)}/${snapshotPathSegment('role', role)}.tar`;

/** Canonical sub-path for the deduplicated managed-container image bundle. */
export const containerImagesBundlePath = (): string => `${SnapshotLayout.containersDir}/images.tar`;

/** Canonical sub-path for one participant's typed metadata slice. */
export const contributionPath = (plugin: string): string =>
	`${SnapshotLayout.contributionsDir}/${encodedSnapshotPathSegment(plugin)}.json`;

// -----------------------------------------------------------------------------
// Metadata schemas — versioned record
// -----------------------------------------------------------------------------

/** A label tuple recorded for re-tag-on-restore. Mirrors
 *  `ContainerLabelTuple` from `contracts/snapshotable.ts` so the
 *  metadata file holds the same shape the runtime adapter filters on. */
export const CapturedContainerSchema = Schema.Struct({
	plugin: Schema.String,
	role: Schema.String,
	/** Original image name the supervisor used when last creating this
	 *  container — must be re-tagged on restore so the supervisor's
	 *  reuse-if-name-and-image-match probe adopts the restored image. */
	imageName: Schema.String,
	/** Temporary tag assigned to this committed container image inside
	 *  the Docker save bundle. Restore loads the bundle once, then
	 *  re-tags this source to `imageName`. */
	snapshotTag: Schema.String,
	/** Sub-path of the committed image bundle inside the artifact. */
	tarPath: Schema.String,
});
export type CapturedContainer = Schema.Schema.Type<typeof CapturedContainerSchema>;

/** Captured host-tree subtree entry — preserved for missing-tolerance
 *  classification on restore. */
export const CapturedSubtreeSchema = Schema.Struct({
	plugin: Schema.String,
	/** Subtree path relative to the runtime root (i.e. `<plugin>/...`). */
	relPath: Schema.String,
	/** `fatal` = restore must refuse if absent on disk at restore time;
	 *  `fine` = silently skipped. Mirrors `SnapshotableDecl.missingTolerance`. */
	missingTolerance: Schema.Literals(['fatal', 'fine']),
	/** Did the subtree carry secret material at capture time? Drives
	 *  the 0o600/0o700 mode round-trip discipline. */
	secretMaterial: Schema.Boolean,
});
export type CapturedSubtree = Schema.Schema.Type<typeof CapturedSubtreeSchema>;

/** Artifact-cache namespaces (`<stackRoot>/cache/<ns>/`) whose cached payload
 *  is an on-chain deploy/mint identity — package id, walrus system/staking
 *  objects, seal key-server object, deepbook pool ids, coin treasury. These
 *  must come back after a restore so the post-restore boot REUSES the deploy
 *  instead of re-running it with fresh ids (which orphans every pre-snapshot
 *  object). Post-D1 the contract has a SINGLE source: capture no longer tars
 *  `cache/<ns>`; the LIVE cache (preserved across a wipe by the D0 coupling)
 *  is the sole copy, and restore PRESERVES it across the stage-and-swap (see
 *  LIVE_RESTORE_PRESERVED_PATHS in restore.ts). A slash-prefixed plugin
 *  namespace (`seal/package`, `deepbook/pools`) nests under its root, so the
 *  root entry covers all of that plugin's namespaces. The generic per-call
 *  `cache/entry` is NOT here and stays dropped on restore. */
export const DEPLOY_CACHE_NAMESPACES: ReadonlyArray<string> = [
	'walrus-deploy',
	'package',
	'seal',
	'deepbook',
	'coin-mint',
	'action',
];

/** Identity slice that fires the cross-chain refusal guard. The
 *  orchestrator threads contributions from participating plugins
 *  through this map — `chain` is the canonical case but other plugins
 *  may contribute (e.g. `postgres.majorVersion`). */
export const IdentitySliceSchema = Schema.Record(Schema.String, Schema.String);
export type IdentitySlice = Schema.Schema.Type<typeof IdentitySliceSchema>;

export const SNAPSHOT_CONTRIBUTION_VERSION = 1 as const;

/** Plugin-owned JSON payload. The orchestrator validates only this
 *  envelope and never interprets `value`; plugins that need stronger
 *  guarantees own their schema at the plugin boundary. */
export const OpaqueContributionStateSchema = Schema.Struct({
	encoding: Schema.Literal('json'),
	value: Schema.Unknown,
});
export type OpaqueContributionState = Schema.Schema.Type<typeof OpaqueContributionStateSchema>;

/** Per-participant metadata envelope. The plugin payload is explicitly
 *  opaque so a successful decode cannot be mistaken for validation of
 *  plugin-owned state. */
export const ContributionDocSchema = versionedDocSchema(SNAPSHOT_CONTRIBUTION_VERSION, {
	plugin: Schema.String,
	identity: Schema.optional(IdentitySliceSchema),
	opaqueState: Schema.optional(OpaqueContributionStateSchema),
});
export type ContributionDoc = Schema.Schema.Type<typeof ContributionDocSchema>;

/** Schema version of the metadata record. Bumped when the on-disk
 *  shape changes in a way that earlier readers cannot ignore. */
export const SNAPSHOT_META_VERSION = 3 as const;

/** Top-level metadata record. Architecture § Snapshot — single canonical
 *  metadata; "metadata absent = do not trust this directory". */
export const SnapshotMetadataSchema = versionedDocSchema(SNAPSHOT_META_VERSION, {
	/** Stable snapshot id (caller-supplied or substrate-minted). */
	id: Schema.String,
	/** User-facing name. It is never used as filesystem authority. */
	label: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	app: Schema.String,
	stack: Schema.String,
	network: Schema.String,
	/** Whether `host-tree.tar` is present in the artifact (false for
	 *  the first-boot / empty-stack capture). */
	hostTreeIncluded: Schema.Boolean,
	subtrees: Schema.Array(CapturedSubtreeSchema),
	containers: Schema.Array(CapturedContainerSchema),
	identity: IdentitySliceSchema,
	/** Plugin keys that contributed a contribution doc. Mirror is on
	 *  disk under `contributions/<encoded-plugin>.json`. */
	participants: Schema.Array(Schema.String),
});
export type SnapshotMetadata = Schema.Schema.Type<typeof SnapshotMetadataSchema>;

// -----------------------------------------------------------------------------
// Catalog-listing shape — projected by service.ts; partial / corrupt
// entries collapse to `null` so the listing tolerates damage.
// -----------------------------------------------------------------------------

export interface SnapshotCatalogEntry {
	readonly id: string;
	readonly directory: string;
	readonly metadata: SnapshotMetadata | null;
}
