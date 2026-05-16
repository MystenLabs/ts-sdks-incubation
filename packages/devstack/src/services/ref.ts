// Type-narrowed shorthand aliases for the `Ref<...>` shapes that
// `services/account.ts` and `services/package.ts` return. The substrate
// type `Ref` lives in `advanced/tag.ts`; this file is only the
// per-service narrowed aliases that downstream consumers reference in
// signatures like `signer: AccountRef` or
// `pkg: PackageRef<typeof seal_dome>`.

import type { Ref } from '../advanced/tag.js';

/** Type-narrowed shorthand for account refs. The shape parameter is
 *  pinned to the canonical `Account` so factory signatures can
 *  declare `signer: AccountRef` instead of repeating the full generic. */
export type AccountRef<Name extends string = string> = Ref<
	Name,
	import('../engine/shared.js').Account
>;

/** Type-narrowed shorthand for package refs. Carries the captured-record
 *  shape as a phantom type parameter so `pkg.captured.<field>` type-checks
 *  against the `capture:` option supplied at declaration. */
export type PackageRef<
	Name extends string = string,
	Captured extends Record<string, unknown> = Record<string, unknown>,
> = Ref<
	Name,
	import('./package/internal.js').Package & { readonly captured: Captured }
>;
