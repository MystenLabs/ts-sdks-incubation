import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/console-mcp.ts", "bin/install.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  external: ["@mysten/sui", "@mysten/seal"], // runtime deps, installed not bundled
});
