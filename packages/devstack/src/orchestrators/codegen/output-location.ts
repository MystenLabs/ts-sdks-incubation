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
//   - Every live stack → `<appRoot>/.devstack/stacks/<effectiveStack>/generated-extras`
//     — a sibling of that stack's manifest at
//     `.devstack/stacks/<stack>/manifest.json`, already gitignored +
//     tsconfig-excluded. Two stacks of the same app therefore never clobber
//     each other's dev-only artifacts. There is NO output-dir override:
//     `defineDevstack({ codegen })` exposes no public surface for the dev
//     tree (boot writes only the per-stack `generated-extras` overlay + the
//     id-config file), so the location is a single fixed per-stack rule.
//
// The resolved absolute `extrasDir` is recorded in the per-stack manifest
// (`codegen.extrasDir`) so the reader (the Vite plugin's `@devstack-dev`
// alias) consults the SAME location the writer chose. The committed
// `src/generated` bindings tree is NOT recorded — the `@generated` alias
// always resolves to it directly. Pure + unit-testable; no `process.env`,
// no I/O.

import { join, resolve } from 'node:path';

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
}

export interface ResolvedCodegenOutput {
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for THIS stack — always
	 *  `<appRoot>/.devstack/stacks/<effectiveStack>/generated-extras`
	 *  (gitignored + tsconfig-excluded already). Recorded in the
	 *  manifest as `codegen.extrasDir`; reached via the `@devstack-dev`
	 *  Vite alias. */
	readonly extrasDir: string;
}

/** Resolve `<appRoot>/.devstack/stacks/<stack>/generated-extras` — the
 *  dev-only + secret tree. Always under `.devstack`, so dev-extras never
 *  land in the committed `src/generated/` tree. */
const extrasDirFor = (appRoot: string, stack: string): string =>
	stackSubpath(join, codegenStacksBase(appRoot), stack, 'generated-extras');

/**
 * Resolve the LIVE codegen output location for a stack. See the module
 * header for the rule. Pure — same inputs always yield the same absolute
 * path. A single fixed per-stack rule (no override): every live stack's
 * dev-only `generated-extras` tree lands under
 * `<appRoot>/.devstack/stacks/<effectiveStack>/generated-extras`. Boot
 * writes ONLY this tree (`emitExtras`); it never emits the committed
 * `src/generated` tree — that is owned solely by the stack-free `codegen`
 * verb (which resolves its own output path directly).
 */
export const resolveCodegenOutput = (input: ResolveCodegenOutputInput): ResolvedCodegenOutput => {
	const { appRoot, effectiveStack } = input;
	return {
		extrasDir: extrasDirFor(appRoot, effectiveStack),
	};
};
