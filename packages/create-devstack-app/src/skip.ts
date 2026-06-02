// Path segments to skip when copying the authored template (`template/`) into
// a freshly scaffolded app (`src/index.ts`). These are generated/build
// artifacts that may appear in a dev checkout of the template (e.g. after
// running `devstack apply` locally to author it) but must never be copied into
// a scaffolded app.

/** Path segments (any level) whose presence means the entry is skipped. */
export const SKIP: ReadonlySet<string> = new Set([
	'node_modules',
	'build',
	'dist',
	'.devstack',
	'.turbo',
	'generated',
	'package_summaries',
	'test-results',
	'playwright-report',
	'playwright',
	'tsconfig.app.tsbuildinfo',
	'tsconfig.node.tsbuildinfo',
]);

/** True if a template-relative posix path should be skipped during copy.
 *  Skips when any path segment is in {@link SKIP}, or when a segment is a
 *  generated config sibling (`*.config.js` / `*.config.d.ts`) produced by
 *  tsc-watch sessions in the source repo. */
export function shouldSkip(path: string): boolean {
	for (const p of path.split('/')) {
		if (SKIP.has(p)) return true;
		if (/^.*\.config\.(js|d\.ts)$/.test(p)) return true;
	}
	return false;
}
