// Public plugin authoring entrypoint.
//
// The engine consumes the same resource-native plugin shape exposed to
// authors, so this API module intentionally re-exports the substrate
// contract instead of lowering into a second member/tag model.

export {
	defineId,
	definePlugin,
	dependencyList,
	isPlugin,
	isResourceRef,
	pluginDependencyRefs,
	resource,
	resolveDependencyValues,
	resolvePluginDependencies,
	uniqueResourceRefs,
	type AnyPlugin,
	type AnyResourceRef,
	type CapabilitySource,
	type CapabilitiesFactory,
	type DependencyInput,
	type DependencyList,
	type Plugin,
	type PluginErrorContribution,
	type PluginSpec,
	type ResourceIdOf,
	type ResourceRef,
	type ResourceValueOf,
	type ResolvedDependencies,
	type ResolvedDependencyList,
	type ResolvedDependencyObject,
	type StartContext,
	type WatchDecl,
} from '../substrate/plugin.ts';
