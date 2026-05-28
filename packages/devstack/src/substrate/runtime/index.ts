// Substrate runtime — narrow barrel.
//
// L0 Effect-v4 Layer implementations. Types are declared in `substrate/`;
// this directory wires the runtime. This barrel re-exports ONLY the
// symbols consumed externally (CLI wirings + integration tests) so
// downstream callers don't drag the full L0 dependency cone — node:fs
// sync APIs, sui-execute primitives, host-tree-tar streamers, etc. —
// into their import graphs just to reach for one supervisor handle.
//
// The discipline:
//   - In-tree devstack code (plugins, orchestrators, substrate-internal
//     wiring) imports DIRECTLY from the concrete module
//     (`./projection/state-ref.ts`, `./supervisor/index.ts`, etc.).
//   - The CLI surface (and the few integration tests that need a fully
//     composed runtime) imports through THIS barrel.
//
// When adding a new external symbol: add an explicit re-export below
// AND a comment line identifying the consumer surface. Do NOT switch
// back to `export *` — the previous shape inflated downstream bundles
// with sui-execute and host-tree-tar transitives.

// ---------------------------------------------------------------------
// Projection — `makeProjectionRef`, persistence helpers.
// Consumers: CLI wirings (apply, snapshot, up, main), boot-config-impl,
// api/run-stack (sync variant only).
// ---------------------------------------------------------------------
export { makeProjectionRef, makeProjectionRefSync } from './projection/state-ref.ts';
export {
	persistProjectionChanges,
	readProjectionSnapshot,
	writeProjectionSnapshot,
} from './projection/persisted.ts';

// ---------------------------------------------------------------------
// Cross-process command channel — publisher / subscriber + path helpers.
// Consumers: CLI wirings (apply, snapshot, up).
// ---------------------------------------------------------------------
export {
	commandChannelPaths,
	makeCommandChannelPublisher,
	makeCommandChannelSubscriber,
} from './cross-process/command-channel/index.ts';

// ---------------------------------------------------------------------
// Cross-process roster — claim/release/heartbeat (`up` wires these
// directly because the supervisor protocol leaves them under the CLI's
// scope, not the supervisor service's).
// Consumers: CLI wirings (up).
// ---------------------------------------------------------------------
export { claim, heartbeatFiber, release } from './cross-process/roster.ts';

// ---------------------------------------------------------------------
// Supervisor — handle/types and `startSupervisor` / `supervise` entry
// points.
// Consumers: CLI wirings (up, apply, snapshot, build-verb-layers,
// config-loader, identity, main) + supervisor tests + integration tests.
// ---------------------------------------------------------------------
export { startSupervisor, supervise } from './supervisor/index.ts';
export type {
	SupervisedStack,
	SupervisorCommandHandler,
	SupervisorHandle,
} from './supervisor/index.ts';

// ---------------------------------------------------------------------
// Capability sinks — service + default Layer + contribution types.
// Consumers: capability-sinks tests, supervisor tests, router
// integration tests, run-stack API test.
// ---------------------------------------------------------------------
export {
	CapabilitySinksService,
	layerCapabilitySinks,
	layerCapabilitySinksDefault,
} from './capability-sinks/index.ts';
export type {
	AnyContribution,
	CapabilitySink,
	ContributionKind,
	HarvestContext,
	OrchestratorSinks,
} from './capability-sinks/index.ts';

// ---------------------------------------------------------------------
// Observability — Logger service + default Layers, plus the formatter
// registry the capability-sinks layer composes with.
// Consumers: supervisor tests, capability-sinks tests.
// ---------------------------------------------------------------------
export { FormatterRegistryService } from './observability/index.ts';
export { Logger, layerLogger } from './observability/logger.ts';
export { layerRedactor } from './observability/redaction.ts';
