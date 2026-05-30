// Action plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [ActionSpans.name]:
// inputs.actionName })`. Free-form string literals are a STYLE_GUIDE §16
// violation.

export const ActionSpans = {
	name: 'action.name',
	chain: 'action.chain',
	phase: 'action.phase',
	digest: 'action.digest',
} as const;
