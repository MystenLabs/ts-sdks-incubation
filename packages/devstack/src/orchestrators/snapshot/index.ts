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
	resumeAfterCapture,
	runCapture,
	type SnapshotParticipant,
} from './capture.ts';

// Restore
export {
	graphInputMismatchDetail,
	RestorePhaseError,
	runRestore,
	type RestoreParticipant,
} from './restore.ts';

// Interrupted-restore sentinel + boot-time auto-recovery
export {
	clearRestoreSentinel,
	readRestoreSentinel,
	recoverInterruptedRestore,
	RESTORE_SENTINEL_FILE_NAME,
	RestoreSentinelSchema,
	SNAPSHOT_RESTORE_SENTINEL_VERSION,
	writeRestoreSentinel,
	type RecoverInterruptedRestoreDeps,
	type RestoreSentinel,
} from './interrupted-restore.ts';

// Wipe
export {
	CACHE_DIR_NAME,
	planWipe,
	runWipe,
	SNAPSHOTS_DIR_NAME,
	WipePhaseError,
	type WipeTargets,
} from './wipe.ts';

// Prune
export { PrunePhaseError, runPrune, type PruneResult } from './prune.ts';

// Identity guard
export {
	IdentityContributionConflictError,
	IdentityEmptyError,
	IdentityMismatchError,
	mergeContributions,
	runIdentityGuard,
	type IdentityGuardError,
	type SnapshotRuntimeIdentity,
} from './identity-guard.ts';

// Descriptor types
export {
	containerImagesBundlePath,
	contributionPath,
	computeSnapshotGraphInputFromGraph,
	computeSnapshotGraphInputFromStack,
	DEPLOY_CACHE_NAMESPACES,
	IntegrityFileSchema,
	SnapshotDescriptorError,
	SnapshotGraphInputIdentitySchema,
	SnapshotLayout,
	SnapshotMetadataSchema,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_GRAPH_INPUT_VERSION,
	SNAPSHOT_ID_RULE,
	SNAPSHOT_INTEGRITY_VERSION,
	SNAPSHOT_META_VERSION,
	parseSnapshotId,
	snapshotIdFromString,
	snapshotGraphInputFromIdentity,
	type IntegrityFile,
	type SnapshotGraphInputIdentity,
	type SnapshotNodeInputIdentity,
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
