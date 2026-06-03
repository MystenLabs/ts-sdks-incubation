// Router orchestrator barrel.
//
// Architecture L3 — "Router orchestrator: collects all `Routable`
// decls, mints hostnames from `(app, stack, dispatch-id)`, writes
// file-provider dispatch files atomically, reads IPs from the runtime
// adapter with bounded retry."

export {
	bootstrap,
	DEFAULT_TRAEFIK_IMAGE,
	layerTraefikContainerOpsDocker,
	layerTraefikContainerOpsStub,
	ROUTER_PROFILE_LABEL,
	routerProfileLabelsMatch,
	TRAEFIK_DISPATCH_MOUNT_TARGET,
	TraefikContainerOpsService,
	uniqueSortedEntrypointPorts,
	type BootDecision,
	type BootReport,
	type BootstrapInputs,
	type TraefikContainerOps,
} from './traefik-container.ts';

export {
	currentRouterUserId,
	makeDefaultRouterProfile,
	makeRouterProfile,
	resolveDockerContextId,
	ROUTER_PROFILE_VERSION,
	type DefaultRouterProfileOptions,
	type RouterProfile,
	type RouterProfileOptions,
} from './profile.ts';

export {
	EntrypointRegistry,
	layerEntrypointRegistry,
	makeEntrypointRegistry,
	type Entrypoint,
	type EntrypointRegistryShape,
} from './entrypoints.ts';

export {
	CORS_MIDDLEWARE_FILENAME,
	CORS_MIDDLEWARE_NAME,
	renderCorsMiddlewareYaml,
} from './cors.ts';

export {
	DEFAULT_STACK,
	dispatchFileId,
	normalizeDispatchSegment,
	normalizeServiceSegment,
	renderUrl,
	routerHostname,
} from './hostname.ts';

export {
	detectCollisions,
	dispatchFileIdFromFilename,
	dispatchFilename,
	parseDispatchRouteFile,
	parseDispatchRouteMetadata,
	ROUTE_READINESS_HEADER,
	ROUTER_ROUTE_LEASE_VERSION,
	renderRouteYaml,
	resolveRoute,
	type DispatchRouteMetadata,
	type RouteCollisionMetadata,
	type RouteLeaseMetadata,
	type ResolvedRoute,
	type UpstreamResolver,
} from './file-provider.ts';

export {
	layerDockerUpstreamResolver,
	layerRouterConfigLiteral,
	layerRouterService,
	RouterConfig,
	RouterService,
	UpstreamResolverService,
	type RouterConfigShape,
	type RouterServiceShape,
} from './service.ts';

export {
	DispatchWriteFailed,
	EntrypointConflict,
	RouteCollision,
	RouteReadinessProbeFailed,
	RouterBootFailed,
	RouterValidationError,
	UnknownEntrypoint,
	UpstreamResolveTimeout,
	type RouterError,
} from './errors.ts';
