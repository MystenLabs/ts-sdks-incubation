// Coin plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [CoinSpans.type]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const CoinSpans = {
	type: 'coin.type',
	form: 'coin.form',
	fullCoinType: 'coin.fullCoinType',
	decimals: 'coin.decimals',
	source: 'coin.source',
	mint: {
		recipient: 'coin.mint.recipient',
		fullCoinType: 'coin.mint.fullCoinType',
		amount: 'coin.mint.amount',
		digest: 'coin.mint.digest',
		mintedCoinId: 'coin.mint.mintedCoinId',
	},
	metadata: {
		fullCoinType: 'coin.metadata.fullCoinType',
	},
} as const;
