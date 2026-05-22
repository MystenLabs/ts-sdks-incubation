// Public substrate vocabulary. Keep this barrel narrow: brands,
// lifecycle/mode/witness helpers, and manifest envelope types. Engine
// protocol, runtime services, stack-member shapes, identity context,
// projection state, cross-process state, and plugin error-contribution
// internals stay on private module paths.

export {
	appName,
	chainId,
	contentHash,
	endpointKey,
	stackName,
	type AppName,
	type Brand,
	type ChainId,
	type ContentHash,
	type EndpointKey,
	type StackName,
} from './brand.ts';
export type { Assert, Equal, Expect, Not } from './equal.ts';
export type {
	DevstackPluginKindRegistry,
	LifecycleStatus,
	PhaseNarration,
	PluginKind,
	RebootCost,
} from './lifecycle.ts';
export {
	litHash,
	litSiblingKey,
	type LiftedSiblingKey,
	type LitHash,
	type LitSiblingKey,
	type SiblingScope,
	type __SiblingHashConflictError,
} from './lifted-sibling.ts';
export {
	ManifestEnvelopeSchema,
	type EndpointEntry,
	type ManifestEnvelope,
	type ManifestExtras,
	type ManifestExtrasContext,
	type ManifestExtrasInput,
} from './manifest.ts';
export type {
	DefaultNetwork,
	DevstackNetworkModeRegistry,
	NetworkConfig,
	NetworkMode,
} from './network.ts';
export type { DevstackOptions } from './options.ts';
export type {
	ProvidesWitness,
	RequiresWitness,
	Witness,
	WitnessProvidedBy,
	WitnessRequiredBy,
} from './witness.ts';
