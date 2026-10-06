import { FetchHttpClient } from "@effect/platform";
import { Cause, type Effect, Layer, ManagedRuntime, Runtime } from "effect";
import { ConsoleConfigLive } from "./config";
import { ConsoleApiClient } from "./console/ConsoleApiClient";
import { ConsoleStorageService } from "./console/ConsoleStorageService";
import { KeyAdminService } from "./console/KeyAdminService";
import { SealCryptoService } from "./console/SealCryptoService";
import { fetchWithRedirectGuard } from "./safeFetch";

/**
 * Single ManagedRuntime for the entire console-mcp server.
 * All tools run effects against this runtime.
 */

// `FetchHttpClient.Fetch` overrides the `fetch` implementation `HttpClient`
// calls internally — it reads this tag from the fiber's context and falls
// back to `globalThis.fetch` only if unset — so installing
// `fetchWithRedirectGuard` here covers every `HttpClient`-based API call in
// one place. The two raw `fetch()` calls in ConsoleApiClient.ts bypass
// HttpClient entirely and call the same guard directly.
//
// Exported on its own so a test can prove the override actually intercepts `HttpClient`
// traffic, without needing `ConsoleConfigLive`'s env-var-backed config just to
// construct a layer — see tests/runtime.test.ts.
export const HttpLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.Fetch, fetchWithRedirectGuard),
);

// Base layers (config + HTTP client) that every service depends on.
const BaseLayer = Layer.mergeAll(ConsoleConfigLive, HttpLayer);

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

/**
 * Helper for MCP tools. The effect's requirements must be satisfied by
 * AppServices — no `any` cast, so a missing layer is a compile error.
 *
 * `signal` is the MCP request's AbortSignal. Forwarding it interrupts the fiber,
 * and Effect propagates interruption for us: `Effect.sleep` in the upload polling
 * loop stops, and `Effect.tryPromise` hands its own signal to the fetches below.
 * Without it, cancelling a tool call only disconnects the caller while the
 * transfer keeps running.
 */
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
  signal?: AbortSignal,
): Promise<A> =>
  signal ? AppRuntime.runPromise(effect, { signal }) : AppRuntime.runPromise(effect);

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
