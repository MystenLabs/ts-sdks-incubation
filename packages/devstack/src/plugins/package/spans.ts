// Package plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({
// [PackageSpans.publish.phase]: 'build' })`. Free-form string literals
// are a STYLE_GUIDE §16 violation.

export const PackageSpans = {
	publish: {
		phase: 'package.publish.phase',
		package: 'package.publish.package',
		packageName: 'package.publish.packageName',
		packageId: 'package.publish.packageId',
		sourcePath: 'package.publish.sourcePath',
		chainId: 'package.publish.chainId',
		publisher: 'package.publish.publisher',
	},
} as const;
