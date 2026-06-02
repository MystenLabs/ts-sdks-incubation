// Shared list of path segments to skip when copying the template, used by
// BOTH the build-time sync (`scripts/sync-template.ts`) and the scaffold-time
// copy (`src/index.ts`). Keeping a single source of truth avoids the two
// lists drifting (which previously let generated artifacts leak into the
// bundled template or a freshly scaffolded app).
//
// These are generated/build artifacts that may be present in a dev checkout of
// `examples/_template/` but must never ship in the bundled template or a
// scaffolded app.

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
