// Snapshot orchestrator — barrel.
//
// Architecture § L3 Snapshot orchestrator. Name-blind: every public
// surface here takes `SnapshotParticipant` / `RestoreParticipant`
// shapes that already close over their plugin key. Service names
// never appear inside this directory.

// Service surface
export {
	layerSnapshotOrchestrator,
	SnapshotBootError,
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

// Restore
export {
	RESTORE_PENDING_FILE_NAME,
	RestorePhaseError,
	RestorePendingDocumentSchema,
	runRestore,
	SNAPSHOT_RESTORE_PENDING_VERSION,
	type RestoreInputs,
	type RestorePendingDocument,
	type RestoreParticipant,
} from './restore.ts';

// Restore-pending recovery
export {
	recoverPendingRestore,
	RestorePendingRecoveryError,
	type RestorePendingRecoverySummary,
} from './recover-pending.ts';

// Pending marker shapes — shared between `restore.ts` (writer) and
// `recover-pending.ts` (reader). Re-exported for tests + consumers
// that need to inspect a marker out-of-band.
export {
	makePendingMarkerDocument,
	pendingMarkerPath,
	RestorePendingMarkerIoError,
	type RestorePendingContainer,
} from './pending-marker.ts';

// Wipe
export { runWipe, SNAPSHOTS_DIR_NAME, WipePhaseError, type WipeInputs } from './wipe.ts';

// Prune
export {
	PrunePhaseError,
	runPrune,
	type ClassifierDispatch,
	type PruneInputs,
	type PruneResult,
} from './prune.ts';

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

export {
	readSnapshotStateDocument,
	SnapshotStateDocumentError,
	writeSnapshotStateDocument,
} from './state-document.ts';
