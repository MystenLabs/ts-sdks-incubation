import { defineConfig } from "tsdown";

// Bundle dependencies but preserve the bootstrap's dynamic import so the
// runtime guard runs before application modules link on unsupported Node versions.
export default defineConfig({
  entry: { "console-mcp": "bin/entry.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
});
