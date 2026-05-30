// Faucet plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [FaucetSpans.url]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const FaucetSpans = {
	address: 'faucet.address',
	amount: 'faucet.amount',
	budgetMs: 'faucet.budget_ms',
	maxAttempts: 'faucet.max_attempts',
	url: 'faucet.url',
} as const;
