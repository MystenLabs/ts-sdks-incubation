import { FetchHttpClient } from "@effect/platform";
import { type Effect, Layer, ManagedRuntime } from "effect";
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
