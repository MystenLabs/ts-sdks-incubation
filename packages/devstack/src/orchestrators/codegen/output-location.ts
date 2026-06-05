// Per-stack codegen output-location resolver.
//
// notes/per-stack-codegen-design.md §"Output-location rule": two stacks
// of the same app must not emit Move codegen into the SAME
// `src/generated/` dir — the second stack's `codegen.emitted` would
// clobber the first's package-id / wallet-pair-token literals and break
// the already-running app. This pure function is the single decision
// point: it maps (appRoot, effective stack, primary stack) → the output
// dir codegen owns for THIS stack.
//
//   - Primary stack (`effectiveStack === primaryStack`, no explicit
//     `--stack`/`$DEVSTACK_STACK` override) → `<appRoot>/src/generated`
//     (canonical, unchanged, committed-ignored).
//   - Secondary stack (`test`/`e2e`/`demo`/...) →
//     `<appRoot>/.devstack/stacks/<effectiveStack>/generated` — a
//     sibling of that stack's manifest at
//     `.devstack/stacks/<stack>/manifest.json`, already gitignored +
//     tsconfig-excluded.
//   - An app that sets `codegen.outputDir` / `codegen.stackSubdir`
//     explicitly (`defineDevstack({ codegen })`) keeps that behavior
//     verbatim (back-compat escape hatch); per-stack isolation is then
//     the app's responsibility.
//
// The decision is made ONCE here, at the boot seam where both the
// primary and effective stack names are in scope, and the resolved
// absolute `outputDir` is then recorded in the per-stack manifest
// (`codegen.generatedDir`) so the reader (the Vite plugin) consults the
// SAME location the writer chose — read and write are gated by one
// decision, not two. Pure + unit-testable; no `process.env`, no I/O.

import { isAbsolute, join, resolve } from 'node:path';

import { stackSubpath } from '../../substrate/runtime/paths.ts';

/** The app-rooted base under which codegen authors its per-stack subtrees:
 *  `<appRoot>/.devstack`. Mirrors the substrate's `RuntimeRoot` base, but
 *  rooted at the app source tree (codegen output lives with the user's
 *  source, not in engine-private state). The `stacks/<stack>/...` shape is
 *  composed by the shared `stackSubpath` so the two authors (substrate at
 *  `RuntimeRoot`, codegen here) never drift. */
const codegenStacksBase = (appRoot: string): string => resolve(appRoot, '.devstack');

export interface ResolveCodegenOutputInput {
	/** The user application root — codegen output is resolved against
	 *  it. */
	readonly appRoot: string;
	/** The stack the supervisor is actually running (the resolved
	 *  identity's stack: explicit `--stack`/`$DEVSTACK_STACK` >
	 *  `config.stackName` > inferred). */
	readonly effectiveStack: string;
	/** The config's declared `stackName` (`stack.options.stackName`) —
	 *  the primary stack. `undefined` when the config declares none —
	 *  then there is no override to diverge from, so the run is treated
	 *  as primary. */
	readonly primaryStack: string | undefined;
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
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for THIS stack — always
	 *  `<appRoot>/.devstack/stacks/<effectiveStack>/generated-extras`
	 *  (gitignored + tsconfig-excluded already). Independent of the
	 *  primary/secondary `outputDir` branch: the runtime tree lives in
	 *  `src/generated/` for the primary stack, but dev-extras ALWAYS
	 *  live under `.devstack` regardless of stack. Recorded in the
	 *  manifest as `codegen.extrasDir`; reached via the `@devstack-dev`
	 *  Vite alias. */
	readonly extrasDir: string;
	/** Per-stack subdirectory under `outputDir`, threaded through to
	 *  `CodegenRoot.stackSubdir` unchanged. `null` for the
	 *  primary/secondary default rules (the `.devstack/stacks/<stack>`
	 *  location already isolates per stack, so no extra subdir is
	 *  needed); only an explicit `defineDevstack({ codegen.stackSubdir })`
	 *  populates it. */
	readonly stackSubdir: string | null;
}

/** Default primary-stack output dir (relative to `appRoot`). */
const PRIMARY_OUTPUT_SUBPATH = 'src/generated';

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated` for a
 *  secondary stack — sibling of that stack's manifest. The
 *  `stacks/<stack>/...` shape comes from the shared `stackSubpath`
 *  composer (substrate authors the same shape at `RuntimeRoot`). */
const secondaryOutputDir = (appRoot: string, stack: string): string =>
	stackSubpath(join, codegenStacksBase(appRoot), stack, 'generated');

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated-extras` — the
 *  dev-only + secret tree. Always under `.devstack`, for EVERY stack
 *  (primary and secondary), so dev-extras never land in the committed
 *  `src/generated/` tree. */
const extrasDirFor = (appRoot: string, stack: string): string =>
	stackSubpath(join, codegenStacksBase(appRoot), stack, 'generated-extras');

/**
 * Resolve the codegen output location for a stack. See the module
 * header for the rule. Pure — same inputs always yield the same
 * absolute paths.
 *
 * Precedence:
 *   1. Explicit `defineDevstack({ codegen.outputDir })` → honored
 *      verbatim (relative → resolved against `appRoot`). The explicit
 *      `stackSubdir` rides along.
 *   2. Primary stack (`effectiveStack === primaryStack`, or no
 *      `primaryStack` declared) → `<appRoot>/src/generated`,
 *      `stackSubdir: null`.
 *   3. Secondary stack → `<appRoot>/.devstack/stacks/<effectiveStack>/generated`,
 *      `stackSubdir: null`.
 */
export const resolveCodegenOutput = (input: ResolveCodegenOutputInput): ResolvedCodegenOutput => {
	const { appRoot, effectiveStack, primaryStack } = input;
	const explicitStackSubdir = input.explicitStackSubdir ?? null;

	// (1) Explicit override wins — back-compat escape hatch. Per-stack
	// isolation is the app's responsibility once it pins `outputDir`.
	if (input.explicitOutputDir !== undefined) {
		const target = input.explicitOutputDir;
		return {
			outputDir: isAbsolute(target) ? target : resolve(appRoot, target),
			// Dev-extras are ALWAYS under `.devstack` per stack, even when
			// the app pins an explicit `outputDir` — they are gitignored
			// dev-only artifacts that must not land in the app's chosen
			// runtime tree.
			extrasDir: extrasDirFor(appRoot, effectiveStack),
			stackSubdir: explicitStackSubdir,
		};
	}

	// `primaryStack === undefined` means the config declared no `stackName`,
	// so there is no config value for `effectiveStack` to diverge from —
	// the run is the primary run by definition (it falls through to the
	// inferred/default stack with no explicit override). Collapse it to
	// `effectiveStack` so the equality below reads `true`.
	const isPrimary = effectiveStack === (primaryStack ?? effectiveStack);

	// (2) Primary → canonical `src/generated`. (3) Secondary → per-stack
	// `.devstack/stacks/<stack>/generated`. Neither uses `stackSubdir`
	// (the `.devstack` path already isolates per stack); an explicit
	// `stackSubdir` only rides the explicit-outputDir branch above.
	return {
		outputDir: isPrimary
			? resolve(appRoot, PRIMARY_OUTPUT_SUBPATH)
			: secondaryOutputDir(appRoot, effectiveStack),
		extrasDir: extrasDirFor(appRoot, effectiveStack),
		stackSubdir: null,
	};
};
