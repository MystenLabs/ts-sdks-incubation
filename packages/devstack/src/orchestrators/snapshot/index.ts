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
export { RestorePhaseError, runRestore, type RestoreParticipant } from './restore.ts';

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
	DEPLOY_CACHE_NAMESPACES,
	SnapshotDescriptorError,
	SnapshotLayout,
	SnapshotMetadataSchema,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_ID_RULE,
	SNAPSHOT_META_VERSION,
	parseSnapshotId,
	snapshotIdFromString,
	type SnapshotCatalogEntry,
	type SnapshotId,
	type SnapshotMetadata,
} from './descriptor.ts';
