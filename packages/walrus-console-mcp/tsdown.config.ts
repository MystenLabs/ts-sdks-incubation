import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "console-mcp": "bin/entry.ts",
    install: "bin/install.ts",
    configure: "bin/configure.ts",
    importBundle: "bin/importBundle.ts",
  },
  format: "esm",
  platform: "node",
  // Syntax compatibility is separate from the security floors in src/nodeVersion.ts.
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
