// Per-stack codegen output-location resolver.
//
// notes/per-stack-codegen-design.md §"Output-location rule": two stacks
// of the same app must not emit Move codegen into the SAME
// `src/generated/` dir — the second stack's `codegen.emitted` would
// clobber the first's package-id / wallet-pair-token literals and break
// the already-running app. This pure function is the single decision
// point: it maps (appRoot, effective stack, home stack) → the output
// dir codegen owns for THIS stack.
//
//   - Home stack (`effectiveStack === homeStack`, no explicit
//     `--stack`/`$DEVSTACK_STACK` override) → `<appRoot>/src/generated`
//     (canonical, unchanged, committed-ignored).
//   - Non-home stack (`test`/`e2e`/`demo`/...) →
//     `<appRoot>/.devstack/stacks/<effectiveStack>/generated` — a
//     sibling of that stack's manifest at
//     `.devstack/stacks/<stack>/manifest.json`, already gitignored +
//     tsconfig-excluded.
//   - An app that sets `codegen.outputDir` / `codegen.stackSubdir`
//     explicitly (`defineDevstack({ codegen })`) keeps that behavior
//     verbatim (back-compat escape hatch); per-stack isolation is then
//     the app's responsibility.
//
// The decision is made ONCE here, at the boot seam where both the home
// and effective stack names are in scope, and the resolved absolute
// `outputDir` is then recorded in the per-stack manifest
// (`codegen.generatedDir`) so the reader (the Vite plugin) consults the
// SAME location the writer chose — read and write are gated by one
// decision, not two. Pure + unit-testable; no `process.env`, no I/O.

import { isAbsolute, resolve } from 'node:path';

export interface ResolveCodegenOutputInput {
	/** The user application root — codegen output is resolved against
	 *  it. */
	readonly appRoot: string;
	/** The stack the supervisor is actually running (the resolved
	 *  identity's stack: explicit `--stack`/`$DEVSTACK_STACK` >
	 *  `config.stackName` > inferred). */
	readonly effectiveStack: string;
	/** The config's declared `stackName` (`stack.options.stackName`).
	 *  `undefined` when the config declares none — then there is no
	 *  override to diverge from, so the run is treated as home. */
	readonly homeStack: string | undefined;
	/** Explicit `defineDevstack({ codegen: { outputDir } })` value, if
	 *  the app pinned one. Honored verbatim (back-compat) — relative
	 *  paths resolve against `appRoot`. */
	readonly explicitOutputDir?: string | undefined;
	/** Explicit `defineDevstack({ codegen: { stackSubdir } })` value, if
	 *  the app pinned one. Passed through unchanged. */
	readonly explicitStackSubdir?: string | null | undefined;
}

export interface ResolvedCodegenOutput {
	/** Absolute path to the directory codegen owns and overwrites for
	 *  THIS stack. Recorded in the manifest as `codegen.generatedDir`. */
	readonly outputDir: string;
	/** Per-stack subdirectory under `outputDir`, threaded through to
	 *  `CodegenRoot.stackSubdir` unchanged. `null` for the
	 *  home/non-home default rules (the `.devstack/stacks/<stack>`
	 *  location already isolates per stack, so no extra subdir is
	 *  needed); only an explicit `defineDevstack({ codegen.stackSubdir })`
	 *  populates it. */
	readonly stackSubdir: string | null;
}

/** Default home-stack output dir (relative to `appRoot`). */
const HOME_OUTPUT_SUBPATH = 'src/generated';

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated` for a
 *  non-home stack — sibling of that stack's manifest. */
const nonHomeOutputDir = (appRoot: string, stack: string): string =>
	resolve(appRoot, '.devstack', 'stacks', stack, 'generated');

/**
 * Resolve the codegen output location for a stack. See the module
 * header for the rule. Pure — same inputs always yield the same
 * absolute paths.
 *
 * Precedence:
 *   1. Explicit `defineDevstack({ codegen.outputDir })` → honored
 *      verbatim (relative → resolved against `appRoot`). The explicit
 *      `stackSubdir` rides along.
 *   2. Home stack (`effectiveStack === homeStack`, or no `homeStack`
 *      declared) → `<appRoot>/src/generated`, `stackSubdir: null`.
 *   3. Non-home stack → `<appRoot>/.devstack/stacks/<effectiveStack>/generated`,
 *      `stackSubdir: null`.
 */
export const resolveCodegenOutput = (input: ResolveCodegenOutputInput): ResolvedCodegenOutput => {
	const { appRoot, effectiveStack, homeStack } = input;
	const explicitStackSubdir = input.explicitStackSubdir ?? null;

	// (1) Explicit override wins — back-compat escape hatch. Per-stack
	// isolation is the app's responsibility once it pins `outputDir`.
	if (input.explicitOutputDir !== undefined) {
		const target = input.explicitOutputDir;
		return {
			outputDir: isAbsolute(target) ? target : resolve(appRoot, target),
			stackSubdir: explicitStackSubdir,
		};
	}

	// `homeStack === undefined` means the config declared no `stackName`,
	// so there is no config value for `effectiveStack` to diverge from —
	// the run is the home run by definition (it falls through to the
	// inferred/default stack with no explicit override). Collapse it to
	// `effectiveStack` so the equality below reads `true`.
	const isHome = effectiveStack === (homeStack ?? effectiveStack);

	// (2) Home → canonical `src/generated`. (3) Non-home → per-stack
	// `.devstack/stacks/<stack>/generated`. Neither uses `stackSubdir`
	// (the `.devstack` path already isolates per stack); an explicit
	// `stackSubdir` only rides the explicit-outputDir branch above.
	return {
		outputDir: isHome
			? resolve(appRoot, HOME_OUTPUT_SUBPATH)
			: nonHomeOutputDir(appRoot, effectiveStack),
		stackSubdir: null,
	};
};
