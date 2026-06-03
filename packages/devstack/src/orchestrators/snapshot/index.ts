// Snapshot orchestrator — barrel.
//
// Architecture § L3 Snapshot orchestrator. Name-blind: every public
// surface here takes `SnapshotParticipant` / `RestoreParticipant`
// shapes that already close over their plugin key. Service names
// never appear inside this directory.

// Service surface
export {
	layerSnapshotOrchestrator,
	SnapshotIdError,
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
	type SnapshotOrchestratorError,
} from './service.ts';

// Capture
export {
	CapturePhaseError,
	runCapture,
	type CaptureInputs,
	type SnapshotCaptureProgress,
	type SnapshotCaptureProgressPhase,
	type SnapshotParticipant,
	type SnapshotProgressReporter,
} from './capture.ts';

// Command-level primitive shared by every `snapshot.capture` publisher
// (supervisor command handler, offline CLI path, future web dashboard).
export { captureSnapshot, type CaptureSnapshotArgs } from './capture-command.ts';

// Restore
export {
	RestorePhaseError,
	runRestore,
	type RestoreInputs,
	type RestoreParticipant,
} from './restore.ts';

// Wipe
export {
	CACHE_DIR_NAME,
	planWipe,
	runWipe,
	SNAPSHOTS_DIR_NAME,
	WipePhaseError,
	type WipeInputs,
	type WipeTargets,
} from './wipe.ts';

// Prune
export { PrunePhaseError, runPrune, type PruneInputs, type PruneResult } from './prune.ts';

// Identity guard
export {
	IdentityContributionConflictError,
	IdentityEmptyError,
	IdentityMismatchError,
	IdentityMissingLiveError,
	IdentityMissingSnapshotError,
	mergeContributions,
	requireIdentity,
	runIdentityGuard,
	runRuntimeIdentityGuard,
	type IdentityContribution,
	type IdentityGuardError,
	type SnapshotRuntimeIdentity,
} from './identity-guard.ts';

// Descriptor types
export {
	containerImagePath,
	containerImagesBundlePath,
	contributionPath,
	IdentitySliceSchema,
	IntegrityFileSchema,
	OpaqueContributionStateSchema,
	SnapshotDescriptorError,
	SnapshotLayout,
	SnapshotMetadataSchema,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_ID_RULE,
	SNAPSHOT_INTEGRITY_VERSION,
	SNAPSHOT_META_VERSION,
	isValidSnapshotId,
	parseSnapshotId,
	snapshotIdFromString,
	type CapturedContainer,
	type CapturedSubtree,
	type ContributionDoc,
	type IdentitySlice,
	type IntegrityFile,
	type OpaqueContributionState,
	type SnapshotCatalogEntry,
	type SnapshotId,
	type SnapshotMetadata,
} from './descriptor.ts';

export {
	computeArtifactIntegrity,
	SnapshotIntegrityError,
	verifyArtifactIntegrity,
	writeArtifactIntegrity,
} from './integrity.ts';
