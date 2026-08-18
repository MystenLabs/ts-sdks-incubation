import { defineConfig } from "tsdown";

/**
 * Build config for the MCPB bundle (one-file distribution).
 *
 * Unlike the default build (tsdown.config.ts), this inlines ALL dependencies so
 * the emitted dist/console-mcp.js runs standalone with plain `node` — no
 * node_modules required inside the .mcpb. Seal/Sui are pure JS (no WASM), so
 * they bundle cleanly.
 *
 * The Node floor is stated in three places that must agree — this `target`,
 * package.json `engines.node`, and manifest.json `compatibility.runtimes.node`.
 * They disagreed once (manifest ≥22 / target node22 / engines ≥24), which let a
 * Node 22 host pass the .mcpb compatibility gate, fail the npx one, and run code
 * that had been typechecked against a newer API than it shipped.
 *
 * `@types/node` is deliberately NOT pinned to that floor: it tracks the
 * ts-sdks-incubation catalog (^25), which is the point of the alignment this
 * branch does. The gap is a real if narrow hazard — a Node 25-only API would
 * compile clean and die at runtime on the supported floor — and is accepted
 * because CI builds and tests on the floor itself (Node 24), so anything that
 * reaches for a newer runtime API fails there rather than in a user's stdio log.
 */
export default defineConfig({
  entry: ["bin/console-mcp.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],
  // manifest.json entry_point expects dist/console-mcp.js; inline the dynamic
  // install.js import so the bundle stays a single file
  outputOptions: {
    entryFileNames: "[name].js",
    inlineDynamicImports: true,
  },
});
