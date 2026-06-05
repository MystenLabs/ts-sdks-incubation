// Canonical log-attribute keys.
//
// Centralises the attribute-key vocabulary so every `Effect.annotateLogs`
// call uses the same keys — engine-dimensional (`devstack.*`, `error.*`,
// `process.exit.*`, `container.*`) plus http/process-generic keys
// (`http.*`, `server.*`). (Span recording was removed; these constants
// now exist purely as a shared logging vocabulary.)

/** Canonical log-attribute keys. Engine-dimensional + http/process generic. */
export const LogAttr = {
	app: 'devstack.app',
	stack: 'devstack.stack',
	network: 'devstack.network',
	plugin: 'devstack.plugin',
	role: 'devstack.role',
	phase: 'devstack.phase',
	containerName: 'container.name',
	containerRole: 'container.role',
	event: 'event.name',
	errorCode: 'error.code',
	errorCause: 'error.cause',
	errorMessage: 'error.message',
	exitCode: 'process.exit.code',
	exitSignal: 'process.exit.signal',
	exitStatus: 'process.exit.status',
	endpointKey: 'devstack.endpoint.key',
	httpMethod: 'http.method',
	httpPath: 'http.path',
	httpUrl: 'http.url',
	host: 'server.address',
	logTag: 'log.tag',
	port: 'server.port',
	cycleId: 'devstack.cycle.id',
	op: 'devstack.op',
	requestId: 'devstack.request.id',
	rosterHeartbeatIntervalMs: 'roster.heartbeat.intervalMs',
	serviceName: 'devstack.service.name',
	stageAndSwapStagingPath: 'stageAndSwap.stagingPath',
	stageAndSwapTargetPath: 'stageAndSwap.targetPath',
	cacheCorruption: 'cache.corruption',
	strategyKey: 'strategy.key',
	strategyAutoMounted: 'strategy.autoMounted',
	artifactPublisherNamespace: 'artifactPublisher.namespace',
	artifactPublisherChain: 'artifactPublisher.chain',
	artifactPublisherContentHash: 'artifactPublisher.contentHash',
	artifactPublisherPath: 'artifactPublisher.path',
	stackLockPath: 'devstack.stack-lock.path',
	stackLockTimeoutMillis: 'devstack.stack-lock.timeoutMillis',
} as const;
