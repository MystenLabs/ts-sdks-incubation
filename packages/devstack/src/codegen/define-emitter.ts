// Codegen emitter plug-in interface.
//
// Each emitter is a `{ name, emit }` pair. Emit runs once per Codegen
// build cycle, receives the resolved package set + the user-configured
// output directory, and produces an Effect that does whatever the
// emitter needs (generate TS bindings, dapp-kit config, registry JSON,
// …). Errors flow through `CodegenError` so a multi-emitter run can
// surface which emitter failed.
//
// Built-in emitters: `BindingsEmitter` (Move → TS bindings via
// `@mysten/codegen`), `StackHandleEmitter` (accounts/services/extras/
// captured handles), `DappKitConfigEmitter` (partial dapp-kit config
// the user's hand-written `dapp-kit.ts` spreads).
//
// User emitters: `defineEmitter({ name, emit })` returns the same
// shape — drop the result into `Codegen({ emitters: [...] })` and it
// runs alongside the built-ins.

import type { Effect } from 'effect';
import type { CodegenError } from './errors.js';

/** Per-package row inside a `CodegenContext`. The shape unifies what
 *  every emitter needs — name, on-chain id, MVR placeholder. Local
 *  packages additionally carry `sourcePath` (used by `BindingsEmitter`
 *  to invoke `sui move summary`); known packages have it undefined. */
export interface CodegenPackage {
	readonly name: string;
	readonly packageId: string;
	/** Move-Verifiable Resolver placeholder name. Emitters substitute
	 *  this in generated code instead of hard-coding `packageId` so the
	 *  emitted bindings stay portable across networks. */
	readonly mvrPlaceholder: string;
	/** Absolute path to the Move source root. Present for packages
	 *  produced by `Package(..., source)` (i.e. `LocalPackage`);
	 *  undefined for `KnownPackage(...)`. Emitters that need source —
	 *  `BindingsEmitter` for `sui move summary` — filter to entries
	 *  where this is defined. */
	readonly sourcePath?: string;
	/** Opaque object-ids captured at publish time. Open record so
	 *  emitter plug-ins can read whatever the caller's `capture:` lambda
	 *  extracted. Undefined for packages where the upstream factory
	 *  didn't surface any captured state. */
	readonly captured?: Record<string, unknown>;
}

/** Per-emit invocation context. Stable across the run; emitters share
 *  the same `packages` and `outputDir`. */
export interface CodegenContext {
	readonly packages: ReadonlyArray<CodegenPackage>;
	/** Absolute output directory. Each emitter writes under `outputDir`;
	 *  conventions like `<outputDir>/bindings/`, `<outputDir>/dapp-kit/`
	 *  let multiple emitters coexist. */
	readonly outputDir: string;
}

/** Plug-in emitter contract. `name` identifies the emitter in logs and
 *  error messages; `emit` runs the codegen body and produces an Effect
 *  that resolves on success or fails with `CodegenError`.
 *
 *  The `R` parameter declares which infra services the emitter pulls
 *  from the surrounding scope. `Codegen({...})` provides the standard
 *  infra (`NodeServicesLayer` + per-stack identity + the registry
 *  services that back `gatherManifest`), so most emitters reach for
 *  more than `never` worth of services — the registries, the user's
 *  `Extras` Effect (whose R is `any` by construction), and so on.
 *  Defaulting `R` to `any` lets emitter authors write straightforward
 *  `Effect.gen` bodies without sprinkling `as Effect<..., any>` casts
 *  at the boundary. Emitters that want to be strict about their
 *  service requirements can pin `R` explicitly (e.g.
 *  `Emitter<ChildProcessSpawner>` on `BindingsEmitter`) and TS will
 *  enforce it at the `defineEmitter` call site.
 *
 *  `Codegen` iterates emitters as `ReadonlyArray<Emitter>` (see
 *  services/codegen.ts); the runtime always provides every R any
 *  built-in emitter could need, so the loose default is sound for the
 *  array-iteration site. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Emitter<R = any> {
	readonly name: string;
	readonly emit: (ctx: CodegenContext) => Effect.Effect<void, CodegenError, R>;
}

/** Helper to define an emitter. Returns its argument unchanged — the
 *  function exists so plug-in authors get inferred parameter types and
 *  TS infers the right shape for `emitters: [...]` arrays without an
 *  explicit annotation at the call site.
 *
 *  Defaults `R` to `any` to match `Emitter`'s default — see the note
 *  on `Emitter` for why. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const defineEmitter = <R = any>(e: Emitter<R>): Emitter<R> => e;
