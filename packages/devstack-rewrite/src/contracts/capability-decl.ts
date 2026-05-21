// CapabilityDecl — the discriminated union of all capability
// declarations a plugin can emit from `NodePlugin.acquire`.
//
// Architecture § Plugin instance data model. The capability set is
// structurally available to substrate type computation — codegen
// emit shapes survive as literal-typed exports, snapshot descriptors
// retain their per-plugin typed metadata, routable triples stay
// typed in `(plugin-key, dispatch-id)` shape. See Phase-3
// type-prototype finding #1.

import type { CodegenableDecl } from './codegenable.ts';
import type { CompositePrimitiveDecl } from './composite-primitive.ts';
import type { LifenessClassifierDecl } from './liveness-classifier.ts';
import type { RoutableDecl } from './routable.ts';
import type { SnapshotableDecl } from './snapshotable.ts';
import type { StrategyContributorDecl } from './strategy-contributor.ts';

/**
 * The discriminated union. Each variant carries a literal `kind`
 * discriminator the orchestrators dispatch on.
 *
 * `unknown`/`string` on the codegen shape parameters here is the
 * union-of-variants form — individual decls keep their narrow types
 * via the `Caps` generic on `StackMember`.
 */
export type CapabilityDecl =
	| SnapshotableDecl
	| RoutableDecl
	| CodegenableDecl<unknown, string>
	| StrategyContributorDecl<string, unknown>
	| LifenessClassifierDecl
	| CompositePrimitiveDecl;
