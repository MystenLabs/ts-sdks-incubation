// Account plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [AccountSpans.name]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const AccountSpans = {
	address: 'account.address',
	fundAmountMist: 'fund.amount.mist',
	fundCrossCuttingCount: 'fund.cross-cutting.count',
	fundCrossCuttingEntries: 'fund.cross-cutting.entries',
	fundingFrom: 'account.funding.from',
	fundingTo: 'account.funding.to',
	name: 'account.name',
	scheme: 'account.scheme',
	variant: 'account.variant',
} as const;
