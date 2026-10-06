import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/console-mcp.ts", "bin/install.ts", "bin/configure.ts", "bin/importBundle.ts"],
  format: "esm",
  platform: "node",
  // Keep in step with package.json `engines.node`, manifest.json
  // `compatibility.runtimes.node` and `MIN_NODE_MAJOR` in src/nodeVersion.ts,
  // which is what actually refuses an old host at startup. They all state the
  // same floor, so a host the .mcpb gate admits is one npx would also accept
  // and the bundle can run. tests/nodeVersion.test.ts holds them together.
  // @types/node deliberately sits ABOVE the floor to match the
  // ts-sdks-incubation catalog; see the note in tsdown.mcpb.config.ts.
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
