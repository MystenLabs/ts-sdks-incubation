// Sui plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [SuiSpans.mode]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const SuiSpans = {
	autoTickIntervalMs: 'sui.autoTick.intervalMs',
	chain: 'sui.chain',
	container: 'sui.container',
	// Local-faucet lease-broker serialization keys. Owned here because
	// the sui plugin owns the local-faucet container + its lease shape;
	// the faucet plugin only sees the strategy dispatch.
	localFaucetLeaseKey: 'faucet.lease.key',
	localFaucetLeaseOwner: 'faucet.lease.owner',
	// Fork-faucet impersonation source (the "whale" address).
	forkFaucetWhale: 'sui.fork.faucet.whale',
	liveFaucetUrl: 'sui.live.faucetUrl',
	liveNetwork: 'sui.live.network',
	liveRpcUrl: 'sui.live.rpcUrl',
	mode: 'sui.mode',
} as const;
