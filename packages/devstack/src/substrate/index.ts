// Public substrate vocabulary. Keep this barrel narrow: brands,
// lifecycle/mode helpers, and manifest envelope types. Engine
// protocol, runtime services, stack-member shapes, identity context,
// projection state, cross-process state, and plugin error-contribution
// internals stay on private module paths.

export {
	appName,
	contentHash,
	endpointKey,
	stackName,
	type AppName,
	type Brand,
	type ContentHash,
	type EndpointKey,
	type StackName,
} from './brand.ts';
export type { Assert, Equal, Expect, Not } from './equal.ts';
export type { LifecycleStatus, PhaseNarration, PluginRole } from './lifecycle.ts';
export {
	ManifestEnvelopeSchema,
	ManifestExtrasInvalid,
	ManifestExtrasLookupError,
	type EndpointEntry,
	type ManifestCodegen,
	type ManifestEnvelope,
	type ManifestExtras,
	type ManifestExtrasContext,
	type ManifestExtrasInput,
} from './manifest.ts';
export type { DevstackOptions } from './options.ts';
