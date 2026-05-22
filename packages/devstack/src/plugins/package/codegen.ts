// Package plugin — Codegenable contribution.
//
// Distilled doc §Outputs: "Bindings input — the source path of every
// local Package is read by the bindings emitter (KnownPackages
// filtered out)."
//
// The contribution emitted here is the LIGHTWEIGHT one: package id +
// MVR placeholder + (for local packages) the source path the
// bindings emitter consumes. The HEAVY codegen — `@mysten/codegen`
// emitting typed function shims — happens in the codegen
// ORCHESTRATOR (plugin/codegen layer, NOT this plugin). The
// orchestrator walks every member's caps tuple, finds the
// Package-emitted contributions, and dispatches `@mysten/codegen`
// once across all of them so a single TS program references every
// emitted package binding.
//
// This file therefore declares the SEAM, not the binding bytes.
// Distilled doc §Cross-component references §codegen: package
// "consumes local Package source paths to emit bindings; respects
// the per-package codegen-exclude flag; uses MVR placeholders so
// emitted code stays portable."

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ResolvedLocalPackage, ResolvedKnownPackage } from './registry.ts';

/** Codegenable shape — what each Package contributes to the codegen
 *  orchestrator. Two variants mirror the local/known split. */
export interface PackageBindings {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	/** Present for local packages only — the bindings emitter reads
	 *  this; KnownPackages omit it and the orchestrator skips them
	 *  for bindings emission (compile-time enforcement at the
	 *  factory layer per distilled doc Invariant 9). */
	readonly sourcePath: string | null;
	/** Per-package opt-out (distilled doc §Inputs — "Codegen
	 *  exclusion flag"). */
	readonly excluded: boolean;
}

/** Build the Codegenable contribution for a local package. */
export const makeLocalCodegenable = (
	resolved: ResolvedLocalPackage,
	options: { readonly excluded: boolean },
): CodegenableDecl<'package'> => ({
	kind: 'codegenable',
	emitterName: 'package',
	outputPath: `package/${resolved.mvrPlaceholder}.ts`,
	emit: (ctx) =>
		Effect.sync(() => {
			// The orchestrator picks up these fields and threads them
			// into `@mysten/codegen` along with the source-path read.
			// The literal binding-file bytes are written by the
			// orchestrator, NOT this plugin.
			ctx.exportConst('packageBindings', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: resolved.sourcePath,
				excluded: options.excluded,
			} satisfies PackageBindings);
			return ctx.done();
		}),
});

/** Build the Codegenable contribution for a known package. The
 *  shape is identical except `sourcePath: null`. The codegen
 *  orchestrator filters these out before invoking the bindings
 *  emitter. */
export const makeKnownCodegenable = (
	resolved: ResolvedKnownPackage,
): CodegenableDecl<'package'> => ({
	kind: 'codegenable',
	emitterName: 'package',
	outputPath: `package/${resolved.mvrPlaceholder}.ts`,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('packageBindings', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: null,
				excluded: true, // implicit — KnownPackages never emit bindings.
			} satisfies PackageBindings);
			return ctx.done();
		}),
});
