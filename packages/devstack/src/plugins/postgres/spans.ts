// Postgres plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [PostgresSpans.database]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const PostgresSpans = {
	database: 'postgres.database',
	name: 'postgres.name',
	timeoutMs: 'postgres.timeoutMs',
	version: 'postgres.version',
} as const;
