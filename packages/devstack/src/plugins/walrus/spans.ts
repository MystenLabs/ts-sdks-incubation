// Walrus plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [WalrusSpans.name]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const WalrusSpans = {
	chain: 'walrus.chain',
	committeeSize: 'walrus.committeeSize',
	fundAccount: 'walrus.fund.account',
	fundAddress: 'walrus.fund.address',
	fundExchange: 'walrus.fund.exchange',
	name: 'walrus.name',
	node: 'walrus.node',
	nodeCount: 'walrus.nodeCount',
	ref: 'walrus.ref',
	shards: 'walrus.shards',
	suiVersion: 'walrus.suiVersion',
} as const;
