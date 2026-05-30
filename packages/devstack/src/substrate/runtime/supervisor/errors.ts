// Supervisor-owned typed errors.
//
// Split out of the monolith. These shapes are part of the public
// supervisor surface (re-exported from `./index.ts`).

import { Cause, Data } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { DepGraphError } from '../lifecycle/index.ts';
import type {
	PluginAcquireFailed,
	RestartTargetMissing,
	UnknownDependency,
} from '../lifecycle/index.ts';

export class SupervisorBootError extends Data.TaggedError('SupervisorBootError')<{
	readonly cause: DepGraphError;
}> {}

export class SupervisorPostAcquireFailed extends Data.TaggedError('SupervisorPostAcquireFailed')<{
	readonly cause: Cause.Cause<unknown>;
}> {}

export class CapabilityFactoryFailed extends Data.TaggedError('CapabilityFactoryFailed')<{
	readonly pluginKey: PluginKey;
	readonly message: string;
	readonly cause: unknown;
}> {}

export type SupervisorError =
	| SupervisorBootError
	| SupervisorPostAcquireFailed
	| CapabilityFactoryFailed
	| PluginAcquireFailed
	| RestartTargetMissing
	| UnknownDependency;
