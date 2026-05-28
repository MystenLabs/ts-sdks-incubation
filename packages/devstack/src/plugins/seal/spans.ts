// Seal plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [SealSpans.name]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const SealSpans = {
	chain: 'seal.chain',
	containerName: 'seal.containerName',
	name: 'seal.name',
	ref: 'seal.ref',
	repo: 'seal.repo',
	routedUrl: 'seal.routedUrl',
	servicePath: 'seal.servicePath',
	signer: 'seal.signer',
	subdir: 'seal.subdir',
	url: 'seal.url',
	version: 'seal.version',
} as const;
