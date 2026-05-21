// Typed capability builder.
//
// Architecture open question #10 + Phase-3 type-system rules: replaces
// the fragile `as const` array. The variadic helper infers and
// preserves the per-decl narrow tuple shape WITHOUT requiring the
// plugin author to remember `as const`.
//
// Two surfaces:
//
//   - `capabilities(...decls)` — variadic; returns a literal-typed
//     readonly tuple. The recommended shape for plugin authors.
//   - `CapabilityBuilder` — fluent alternative (chainable
//     `.snapshot(decl).route(decl).codegen(decl)`) for cases where
//     branching is convenient.

import type { CapabilityDecl } from '../contracts/capability-decl.ts';
import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { LifenessClassifierDecl } from '../contracts/liveness-classifier.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';

/**
 * Variadic capability builder. The return type preserves the
 * per-decl narrow types as a readonly tuple — downstream `Caps`
 * inference flows through.
 */
export function capabilities<Decls extends ReadonlyArray<CapabilityDecl>>(...decls: Decls): Decls {
	return decls;
}

/**
 * Fluent capability builder. Each method appends one decl and
 * returns a new builder with the tuple's literal type extended.
 */
export interface CapabilityBuilder<Caps extends ReadonlyArray<CapabilityDecl>> {
	readonly snapshot: (
		decl: SnapshotableDecl,
	) => CapabilityBuilder<readonly [...Caps, SnapshotableDecl]>;
	readonly route: (decl: RoutableDecl) => CapabilityBuilder<readonly [...Caps, RoutableDecl]>;
	readonly codegen: <Shape, Emitter extends string>(
		decl: CodegenableDecl<Shape, Emitter>,
	) => CapabilityBuilder<readonly [...Caps, CodegenableDecl<Shape, Emitter>]>;
	readonly strategy: <Key extends string, Strategy>(
		decl: StrategyContributorDecl<Key, Strategy>,
	) => CapabilityBuilder<readonly [...Caps, StrategyContributorDecl<Key, Strategy>]>;
	readonly liveness: (
		decl: LifenessClassifierDecl,
	) => CapabilityBuilder<readonly [...Caps, LifenessClassifierDecl]>;
	readonly build: () => Caps;
}

/** Construct an empty capability builder. */
export function capabilityBuilder(): CapabilityBuilder<readonly []> {
	const make = <Caps extends ReadonlyArray<CapabilityDecl>>(
		acc: Caps,
	): CapabilityBuilder<Caps> => ({
		snapshot: (decl) => make([...acc, decl] as const),
		route: (decl) => make([...acc, decl] as const),
		codegen: (decl) => make([...acc, decl] as const),
		strategy: (decl) => make([...acc, decl] as const),
		liveness: (decl) => make([...acc, decl] as const),
		build: () => acc,
	});
	return make([] as const);
}
