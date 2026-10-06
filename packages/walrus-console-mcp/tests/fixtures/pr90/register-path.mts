import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs in a child with an isolated home: exercise getClients' real config-path
// resolution and registration, not a separately constructed jsonFileClient.
const root =
  process.env["PR90_TEST_SOURCE_ROOT"] ?? fileURLToPath(new URL("../../../", import.meta.url));
const { getClients } = await import(pathToFileURL(path.join(root, "src/clients.ts")).href);
const { stepRegister } = await import(pathToFileURL(path.join(root, "bin/install.ts")).href);
const [id, action, launcher] = process.argv.slice(2);
const client = getClients().find((entry: { id: string }) => entry.id === id);
if (!client || !launcher) throw new Error(`Missing registry client or launcher: ${id}`);

let result: unknown;
try {
  if (action === "step" || action === "stale") {
    const selected = [client];
    if (action === "stale") {
      const configPath = path.join(
        process.env["HOME"]!,
        ...(id === "cursor" ? [".cursor", "mcp.json"] : [".gemini", "config", "mcp_config.json"]),
      );
      const before = fs.readFileSync(configPath, "utf-8");
      selected.push({
        id: "fixture-stale-save",
        label: "Fixture stale save",
        detect: () => true,
        register: () => fs.writeFileSync(configPath, before),
        manualHint: () => "fixture",
        // The competing writer is not an installed agent to count as configured.
        verify: () => "fixture writer only",
      });
    }
    result = await stepRegister("fixture-package", {
      select: async () => selected,
      // Artifact installation is covered separately with the packed merged build.
      // Only provision the launcher here; all client writes/verification are real.
      install: () => launcher,
    });
  } else {
    client.register(launcher);
    result = { detected: client.detect(), problem: client.verify?.(launcher) ?? null };
  }
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
}
console.log(`PR90_RESULT=${JSON.stringify(result)}`);
