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
// `@mysten/codegen`), `DappKitEmitter` (Phase 3g — emits a dapp-kit
// config file consumers spread into `createNetworkConfig`).
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
	 *  produced by `Package(..., source)` (i.e. `LocalPackageShape`);
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
 *  Emit's R channel is open (`any`) so plug-ins can request infra
 *  services they need (`ChildProcessSpawner` for `BindingsEmitter`,
 *  `FileSystem` for anything that writes). `Codegen({...})` provides
 *  the standard infra (`NodeServicesLayer` + per-stack identity) so
 *  the common cases just work. */
export interface Emitter {
	readonly name: string;
	/* eslint-disable @typescript-eslint/no-explicit-any */
	readonly emit: (ctx: CodegenContext) => Effect.Effect<void, CodegenError, any>;
	/* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Helper to define an emitter. Returns its argument unchanged — the
 *  function exists so plug-in authors get inferred parameter types and
 *  TS infers the right shape for `emitters: [...]` arrays without an
 *  explicit annotation at the call site. */
export const defineEmitter = (e: Emitter): Emitter => e;
