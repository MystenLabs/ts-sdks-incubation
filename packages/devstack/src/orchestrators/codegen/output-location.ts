// Per-stack codegen output-location resolver.
//
// Boot no longer runs codegen — `up` / `apply` write an id-config file to
// `.devstack/stacks/<stack>/` instead. This resolver still owns the per-
// stack `.devstack` dev tree (the `generated-extras` overlay the Vite
// `@devstack-dev` alias reads). The COMMITTED `src/generated` tree is
// written ONLY by the stack-free `codegen` verb, wired separately.
//
// This pure function is the single decision point for the per-stack dev
// output dir: it maps (appRoot, effective stack) → the `.devstack` dir
// codegen-adjacent dev artifacts own for THIS stack.
//
//   - Every live stack → `<appRoot>/.devstack/stacks/<effectiveStack>/generated`
//     — a sibling of that stack's manifest at
//     `.devstack/stacks/<stack>/manifest.json`, already gitignored +
//     tsconfig-excluded. Two stacks of the same app therefore never clobber
//     each other's package-id / wallet-pair-token literals.
//   - An app that sets `codegen.outputDir` / `codegen.stackSubdir`
//     explicitly (`defineDevstack({ codegen })`) owns that output path;
//     per-stack isolation is then the app's responsibility.
//
// The resolved absolute `extrasDir` is recorded in the per-stack manifest
// (`codegen.extrasDir`) so the reader (the Vite plugin's `@devstack-dev`
// alias) consults the SAME location the writer chose. The committed
// `src/generated` bindings tree is NOT recorded — the `@generated` alias
// always resolves to it directly. Pure + unit-testable; no `process.env`,
// no I/O.

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
	/** Explicit `defineDevstack({ codegen: { outputDir } })` value, if
	 *  the app pinned one. Relative paths resolve against `appRoot`. */
	readonly explicitOutputDir?: string | undefined;
	/** Explicit `defineDevstack({ codegen: { stackSubdir } })` value, if
	 *  the app pinned one. Passed through unchanged. */
	readonly explicitStackSubdir?: string | null | undefined;
}

export interface ResolvedCodegenOutput {
	/** Absolute path to the directory codegen owns and overwrites for
	 *  THIS stack's LIVE projection. Always under `.devstack` (gitignored).
	 *  Not recorded in the manifest — the committed `src/generated` tree is
	 *  the binding source the `@generated` alias resolves. */
	readonly outputDir: string;
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for THIS stack — always
	 *  `<appRoot>/.devstack/stacks/<effectiveStack>/generated-extras`
	 *  (gitignored + tsconfig-excluded already). Recorded in the
	 *  manifest as `codegen.extrasDir`; reached via the `@devstack-dev`
	 *  Vite alias. */
	readonly extrasDir: string;
	/** Per-stack subdirectory under `outputDir`, threaded through to
	 *  `CodegenRoot.stackSubdir` unchanged. `null` for the default rule
	 *  (the `.devstack/stacks/<stack>` location already isolates per
	 *  stack, so no extra subdir is needed); only an explicit
	 *  `defineDevstack({ codegen.stackSubdir })` populates it. */
	readonly stackSubdir: string | null;
}

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated` for a live
 *  stack — sibling of that stack's manifest. The `stacks/<stack>/...`
 *  shape comes from the shared `stackSubpath` composer (substrate
 *  authors the same shape at `RuntimeRoot`). */
const liveOutputDir = (appRoot: string, stack: string): string =>
	stackSubpath(join, codegenStacksBase(appRoot), stack, 'generated');

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated-extras` — the
 *  dev-only + secret tree. Always under `.devstack`, so dev-extras never
 *  land in the committed `src/generated/` tree. */
const extrasDirFor = (appRoot: string, stack: string): string =>
	stackSubpath(join, codegenStacksBase(appRoot), stack, 'generated-extras');

/**
 * Resolve the LIVE codegen output location for a stack. See the module
 * header for the rule. Pure — same inputs always yield the same
 * absolute paths.
 *
 * Precedence:
 *   1. Explicit `defineDevstack({ codegen.outputDir })` → honored
 *      verbatim (relative → resolved against `appRoot`). The explicit
 *      `stackSubdir` rides along.
 *   2. Default → `<appRoot>/.devstack/stacks/<effectiveStack>/generated`,
 *      `stackSubdir: null`.
 */
export const resolveCodegenOutput = (input: ResolveCodegenOutputInput): ResolvedCodegenOutput => {
	const { appRoot, effectiveStack } = input;
	const explicitStackSubdir = input.explicitStackSubdir ?? null;

	// (1) Explicit override wins. Per-stack isolation is the app's
	// responsibility once it pins `outputDir`.
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

	// (2) Default → per-stack `.devstack/stacks/<stack>/generated`. The
	// `.devstack` path already isolates per stack, so `stackSubdir` is
	// unused (an explicit `stackSubdir` only rides the explicit-outputDir
	// branch above).
	return {
		outputDir: liveOutputDir(appRoot, effectiveStack),
		extrasDir: extrasDirFor(appRoot, effectiveStack),
		stackSubdir: null,
	};
};
