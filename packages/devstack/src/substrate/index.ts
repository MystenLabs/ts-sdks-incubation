// Public substrate vocabulary. Keep this barrel narrow: plugin authors
// need branded values, tags, stack-member shapes, mode/witness helpers,
// and manifest envelope types. Engine protocol, runtime services,
// identity context, projection state, cross-process state, and plugin
// error-contribution internals stay on private module paths.

export {
	appName,
	chainId,
	contentHash,
	endpointKey,
	pluginKey,
	stackName,
	type AppName,
	type Brand,
	type ChainId,
	type ContentHash,
	type EndpointKey,
	type PluginKey,
	type StackName,
} from './brand.ts';
export type { Assert, Equal, Expect, Not } from './equal.ts';
export type { LifecycleStatus, PhaseNarration, PluginKind, RebootCost } from './lifecycle.ts';
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
export type { DefaultNetwork, NetworkConfig, NetworkMode } from './network.ts';
export type { DevstackOptions, OptionsLike } from './options.ts';
export {
	MEMBER_BRAND,
	type AcquireContext,
	type AnyMember,
	type BuildContext,
	type CapabilitiesFactory,
	type MemberBrand,
	type MemberBranded,
	type MissingProviders,
	type StackMember,
	type WatchDecl,
	type __MemberNotConsumedError,
	type __MissingProvidersError,
} from './plugin.ts';
export { defineTag, type AnyTag, type ResolvedOf, type Tag, type TagIdOf } from './tag.ts';
export type {
	ProvidesWitness,
	RequiresWitness,
	Witness,
	WitnessProvidedBy,
	WitnessRequiredBy,
} from './witness.ts';
