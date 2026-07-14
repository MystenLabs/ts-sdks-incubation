import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { resolvedString } from "../src/config";

// Drive resolvedString through a custom ConfigProvider so we control the "env" without
// touching process.env. Mirrors process.env semantics: a missing map key = unset var,
// an "" value = an exported-but-empty var.
const run = (env: Record<string, string>, fileValue: string | undefined, fallback = "") =>
  Effect.runPromise(
    resolvedString("CONSOLE_API_KEY", fileValue, fallback).pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
    ),
  );

describe("resolvedString — env → file → fallback priority", () => {
  it("a non-empty env var wins over a saved file value", async () => {
    expect(await run({ CONSOLE_API_KEY: "hbr_env" }, "hbr_file")).toBe("hbr_env");
  });

  it("an empty env var falls through to the saved file value (review #3: no shadowing)", async () => {
    expect(await run({ CONSOLE_API_KEY: "" }, "hbr_file")).toBe("hbr_file");
  });

  it("a whitespace-only env var falls through to the saved file value", async () => {
    expect(await run({ CONSOLE_API_KEY: "   " }, "hbr_file")).toBe("hbr_file");
  });

  it("an unset env var uses the saved file value", async () => {
    expect(await run({}, "hbr_file")).toBe("hbr_file");
  });

  it("missing everywhere resolves to the fallback without throwing (review #4)", async () => {
    expect(await run({}, undefined, "")).toBe("");
    expect(await run({ CONSOLE_API_KEY: "" }, undefined, "https://fallback")).toBe(
      "https://fallback",
    );
  });

  it("trims surrounding whitespace on the resolved value", async () => {
    expect(await run({ CONSOLE_API_KEY: "  hbr_env  " }, undefined)).toBe("hbr_env");
  });
});
