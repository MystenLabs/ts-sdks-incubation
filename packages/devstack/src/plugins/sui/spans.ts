// Sui plugin attribute-key vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// These keys back leveled log annotations (`Effect.annotateLogs({
// [SuiSpans.container]: value })`) and the account plugin's
// cross-cutting funding annotations. Free-form string literals are a
// STYLE_GUIDE §16 violation.

export const SuiSpans = {
	autoTickIntervalMs: 'sui.autoTick.intervalMs',
	chain: 'sui.chain',
	container: 'sui.container',
	mode: 'sui.mode',
} as const;
