// Per-domain phase-string registries. Every tagged error class with a
// `phase` field reads its allowed values from here so the set is
// enumerable, change-tracked, and structurally typed end-to-end. New
// phases are added by extending the tuple and updating the throw site
// in the same commit — `tsc` will flag any throw that doesn't match.
//
// Two error classes intentionally keep `phase: Schema.String` open:
//   - `DockerError` — phases mix CLI verbs (`'docker run'`, `'docker
//     inspect ports (config)'`) with router-internal labels
//     (`'router.dynamic-dir'`) and interpolated names (e.g.
//     `\`docker network connect ${ROUTER_NETWORK}\``). The closed-set
//     payoff is low and the maintenance cost on every router/inventory
//     edit is real.
//   - `HostProcessError` — `phase` is whatever command string the
//     plugin author passed to `hostScript(...)`; the value is
//     user-controlled by construction.
//
// Phases are stable identifiers consumed by `pretty-error.ts` and TUI
// `PHASE_STATUS_OVERRIDES`. Renaming a phase here is a downstream
// breaking change; prefer adding new phases over reshaping old ones.

export const SuiPhases = [
	'network-create',
	'postgres-up',
	'sui-up',
	'ready-probe',
	'fetch-chainId',
	'indexer-ready',
	'wait-for-transactions-ready',
	// Fork-mode lifecycle phases (Phase 1 of sui-fork integration).
	// `fork-lock`           — acquiring/releasing the per-stack data-dir
	//                         file lock that prevents two `sui-fork`
	//                         containers from trampling the same on-disk
	//                         state (R5 mitigation).
	// `fork-status`         — `ForkingService.GetStatus` round trip used
	//                         to derive `forkedAtCheckpoint` / `upstream`.
	// `fork-advance-clock`  — `ForkingService.AdvanceClock` wrapper.
	// `fork-advance-checkpoint` — `ForkingService.AdvanceCheckpoint` wrapper.
	// `fork-impersonate`    — `executeImpersonated` helper failures
	//                         (Phase 2 — empty-signature txs).
	// `fork-unsupported`    — Adapter-guard rejections for surfaces sui-fork
	//                         doesn't support (`getBalance` etc.; R1).
	// `fork-meta`           — `.devstack/stacks/<stack>/sui-fork/meta.json`
	//                         consistency gate (Phase 4 P4.16 / R6 mitigation).
	'fork-lock',
	'fork-status',
	'fork-advance-clock',
	'fork-advance-checkpoint',
	'fork-impersonate',
	'fork-unsupported',
	'fork-meta',
] as const;
export type SuiPhase = (typeof SuiPhases)[number];

export const PublishPhases = [
	'hash',
	'scrub',
	'build',
	'publish-tx',
	'parse',
	'register-coins',
] as const;
export type PublishPhase = (typeof PublishPhases)[number];

export const AccountPhases = ['load-key', 'decode-key', 'write-key', 'fund'] as const;
export type AccountPhase = (typeof AccountPhases)[number];

export const WalrusPhases = [
	'image',
	'network',
	'deploy',
	'exchange',
	'nodes',
	'proxy',
	'seed',
] as const;
export type WalrusPhase = (typeof WalrusPhases)[number];

export const SealPhases = [
	'port-alloc',
	'image',
	'keygen',
	'publish',
	'register',
	'config-render',
	'container',
	'ready',
	'rotate',
	'seal',
] as const;
export type SealPhase = (typeof SealPhases)[number];

export const DeepbookPhases = [
	'publish',
	'create-pools',
	'market-maker-tick',
	'deepbook',
	'deepbookMarketMaker',
	// Phase 4 — margin lifecycle additions
	'margin-publish',
	'margin-setup',
	'margin-pools',
	'margin-seed',
] as const;
export type DeepbookPhase = (typeof DeepbookPhases)[number];

export const PythPhases = [
	'publish',
	'create-feeds',
	'pusher-fetch',
	'pusher-update',
	'pyth',
] as const;
export type PythPhase = (typeof PythPhases)[number];

export const PostgresPhases = [
	'image',
	'port-alloc',
	'container',
	'ready',
	'createdb',
	'postgres',
] as const;
export type PostgresPhase = (typeof PostgresPhases)[number];

export const DeepbookIndexerPhases = [
	'image',
	'port-alloc',
	'container',
	'ready',
	'indexer',
] as const;
export type DeepbookIndexerPhase = (typeof DeepbookIndexerPhases)[number];

// Phase 3 — DeepBook server (REST API) lifecycle phases. Mirrors the
// indexer's shape; the only meaningful difference is that the server
// has a ready probe against `/` returning 200 (the indexer's metrics
// endpoint is the closest equivalent).
export const DeepbookServerPhases = [
	'image',
	'port-alloc',
	'container',
	'ready',
	'server',
] as const;
export type DeepbookServerPhase = (typeof DeepbookServerPhases)[number];

export const SuiCliPhases = [
	'sui move build',
	'docker run -d (build container)',
	'docker start (build container)',
	'docker inspect (build container)',
	'docker rm (build container)',
	'docker exec (sui move build)',
	'docker exec (sui move summary)',
	'SuiBuildContainer acquire',
	'SuiBuildContainer.runBuild',
	'SuiBuildContainer.runSummary',
	'scrubCachedMoveLocks readDirectory',
] as const;
export type SuiCliPhase = (typeof SuiCliPhases)[number];

export const CodegenPhases = ['read', 'generate', 'write'] as const;
export type CodegenPhase = (typeof CodegenPhases)[number];

export const WalletAppPhases = ['listen'] as const;
export type WalletAppPhase = (typeof WalletAppPhases)[number];

export const ManifestPhases = ['write'] as const;
export type ManifestPhase = (typeof ManifestPhases)[number];
