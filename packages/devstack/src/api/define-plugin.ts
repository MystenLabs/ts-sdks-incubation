// Public plugin authoring entrypoint.
//
// The engine consumes the same resource-native plugin shape exposed to
// authors, so this API module intentionally re-exports the substrate
// contract instead of lowering into a second member/tag model.

export {
	defineId,
	definePlugin,
	dependencyList,
	computedInputIdentity,
	isPlugin,
	isResourceRef,
	pluginDependencyRefs,
	resource,
	resolveDependencyValues,
	resolvePluginDependencies,
	staticInputIdentity,
	uniqueResourceRefs,
	type AnyPlugin,
	type AnyResourceRef,
	type DependencyInput,
	type DependencyList,
	type NodeInputContribution,
	type Plugin,
	type PluginSpec,
	type ResourceIdOf,
	type ResourceRef,
	type ResourceValueOf,
	type ResolvedDependencies,
	type ResolvedDependencyList,
	type ResolvedDependencyObject,
	type WatchDecl,
} from '../substrate/plugin.ts';

export type { StaticCodegenSource } from '../contracts/codegenable.ts';

export type { RowSection } from '../substrate/projection.ts';
