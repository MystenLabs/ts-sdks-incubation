import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/console-mcp.ts", "bin/install.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  external: ["@mysten/sui", "@mysten/seal"], // runtime deps, installed not bundled
  // package.json bin and manifest.json expect .js, not tsdown's default .mjs
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
});
