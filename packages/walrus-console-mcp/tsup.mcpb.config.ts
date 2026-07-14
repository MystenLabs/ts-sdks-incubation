import { defineConfig } from "tsup";

/**
 * Build config for the MCPB bundle (one-file distribution).
 *
 * Unlike the default build (tsup.config.ts), this inlines ALL dependencies so
 * the emitted dist/console-mcp.js runs standalone with plain `node` — no
 * node_modules required inside the .mcpb. Seal/Sui are pure JS (no WASM), so
 * they bundle cleanly.
 */
export default defineConfig({
  entry: ["bin/console-mcp.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],
});
