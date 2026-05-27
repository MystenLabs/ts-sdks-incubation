// Deepbook plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [DeepbookSpans.name]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.
//
// Pyth is a deepbook implementation detail (see `./pyth/`), so pyth
// span keys live here under a nested `pyth` sub-object to keep
// vocabulary discovery scoped to the owning plugin.

export const DeepbookSpans = {
	chain: 'deepbook.chain',
	fundAmount: 'fund.amount',
	fundCoin: 'fund.coin',
	name: 'deepbook.name',
	packageId: 'deepbook.packageId',
	poolCount: 'deepbook.pool.count',
	publisher: 'deepbook.publisher',
	pyth: {
		feedCount: 'pyth.feed.count',
		packageId: 'pyth.packageId',
	},
} as const;
