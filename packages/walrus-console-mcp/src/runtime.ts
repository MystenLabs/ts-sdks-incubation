import { FetchHttpClient } from "@effect/platform";
import { Cause, type Effect, Layer, ManagedRuntime, Runtime } from "effect";
import { ConsoleConfigLive } from "./config";
import { ConsoleApiClient } from "./console/ConsoleApiClient";
import { ConsoleStorageService } from "./console/ConsoleStorageService";
import { KeyAdminService } from "./console/KeyAdminService";
import { SealCryptoService } from "./console/SealCryptoService";

/**
 * Single ManagedRuntime for the entire console-mcp server.
 * All tools run effects against this runtime.
 */

// Base layers (config + HTTP client) that every service depends on.
const BaseLayer = Layer.mergeAll(ConsoleConfigLive, FetchHttpClient.layer);

// Provide the base layers into every service, and re-export the base
// services too so config-only tools (e.g. ping_console) keep working.
export const AppLayer = Layer.mergeAll(
  ConsoleApiClient.Default,
  SealCryptoService.Default,
  ConsoleStorageService.Default,
  KeyAdminService.Default,
).pipe(Layer.provideMerge(BaseLayer));

export type AppServices = Layer.Layer.Success<typeof AppLayer>;

export const AppRuntime = ManagedRuntime.make(AppLayer);

// Helper for MCP tools. The effect's requirements must be satisfied by
// AppServices — no `any` cast, so a missing layer is a compile error.
export const runPromise = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  AppRuntime.runPromise(effect);

/**
 * Recover the typed domain error (or defect) that `runPromise` wrapped in a
 * FiberFailure. A FiberFailure's own `.message` is the generic "An error has
 * occurred", so formatting it directly would hide the tagged error's fields.
 * Non-Effect errors pass through unchanged.
 */
export function unwrapFiberFailure(error: unknown): unknown {
  if (Runtime.isFiberFailure(error)) {
    const cause = error[Runtime.FiberFailureCauseId];
    const failure = Cause.failureOption(cause);
    if (failure._tag === "Some") return failure.value;
    const defect = Cause.dieOption(cause);
    if (defect._tag === "Some") return defect.value;
  }
  return error;
}
