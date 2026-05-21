// L0 observability barrel.
//
// Six primitives:
//   - Logger              — bounded per-tag structured log buffer.
//   - SpanAttr + helpers  — span/annotation conventions.
//   - cascade-formatter   — pure Cause → string walker (CLI / TUI / prune).
//   - FormatterRegistry   — substrate-owned per-tag formatter store;
//                            populated by the supervisor's harvest loop
//                            from each plugin's `errorContributions`.
//   - pretty-error        — IO convenience over the formatter +
//                            StructuredError projection.
//   - capture             — collapsed subprocess output capture.

export * from './logger.ts';
export * from './spans.ts';
export * from './cascade-formatter.ts';
export * from './formatter-registry.ts';
export * from './pretty-error.ts';
export * from './subprocess-capture.ts';
