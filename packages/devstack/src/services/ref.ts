// Ref — the canonical handle returned by every `services/*` factory.
//
// A Ref is simultaneously:
//   - A typed value passed into other factories (`signer: alice`).
//   - An Effect Layer composed by `devstack(...)`.
//   - An Effect Context.Service tag yielded at runtime (`yield* alice`).
//
// Concretely, a Ref *is* a `PluginTag` from `src/tag.ts` with one extra
// piece of metadata: the `_section` discriminator drives the new TUI's
// section-grouped rendering ('service' | 'package' | 'account' | 'app' |
// 'action'). The legacy `__kind` field stays for engine compatibility;
// the new `_section` lives alongside it and the Phase-4 TUI reads it.
//
// Phase 2 makes every factory in `src/services/` return a `Ref`. The old
// `PluginTag` shape is preserved verbatim — we just stamp `_section` and
// re-cast — so the engine, registries, and existing TUI keep working.

import type { PluginTag } from '../advanced/tag.js';

/** Section discriminator used by the TUI to group entries. Five values
 *  matching the user-intent framing: services / packages / accounts /
 *  actions / app. */
export type RefSection = 'service' | 'package' | 'account' | 'app' | 'action';

/** The handle every `services/*` factory returns. Structurally a
 *  `PluginTag` with one extra readonly field (`_section`). Use this
 *  type for cross-references in factory signatures (`signer: Ref<...>`,
 *  `needs: ReadonlyArray<Ref<...>>`). */
export interface Ref<Name extends string, Shape, R = never, E = never>
	extends PluginTag<Name, Shape, R, E> {
	readonly _section: RefSection;
}

/** Type-narrowed shorthand for account refs. The shape parameter is
 *  pinned to the canonical `Account` so factory signatures can declare
 *  `signer: AccountRef` instead of repeating the full generic. */
export type AccountRef<Name extends string = string> = Ref<
	Name,
	import('../primitives/shared.js').Account
>;

/** Type-narrowed shorthand for package refs. Carries the captured-record
 *  shape as a phantom type parameter so `pkg.captured.<field>` type-checks
 *  against the `capture:` option supplied at declaration. */
export type PackageRef<
	Name extends string = string,
	Captured extends Record<string, unknown> = Record<string, unknown>,
> = Ref<
	Name,
	import('../primitives/publish-move.js').Package & { readonly captured: Captured }
>;

/** Stamp `_section` onto an existing PluginTag-like value. Used by
 *  every `services/*` factory after the underlying primitive returns.
 *  Also overwrites `__kind` so the engine's section-grouped TUI reads
 *  the new section rather than the legacy 'service'/'action' the
 *  underlying primitive set.
 *
 *  The input is intentionally typed as `unknown` so factories can pass
 *  the raw v3 primitive return type through without first force-casting
 *  it to a generic `PluginTag` (which can erase generic parameters via
 *  TS's distributive inference). The output preserves the input type
 *  unchanged so `yield* hello` still resolves to the published-package
 *  shape downstream. */
export const withSection = <T>(tag: T, section: RefSection): T & { readonly _section: RefSection } => {
	return Object.assign(tag as object, { _section: section, __kind: section }) as unknown as T & {
		readonly _section: RefSection;
	};
};
