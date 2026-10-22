import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_VERSION_RANGE,
  assertSupportedNode,
  unsupportedNodeMessage,
} from "../src/nodeVersion.js";

const ROOT = path.join(__dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf-8");
const FLOORS = ["22.23.4", "24.22.1", "26.12.1"];

const supported = [
  ...FLOORS,
  "22.23.5",
  "22.24.0",
  "24.22.2",
  "24.23.0",
  "26.12.2",
  "26.13.0",
  "22.23.4+vendor.001",
  "24.22.1+build-1",
  "26.12.1+build.1",
];
const unsupported = [
  "22.23.3",
  "24.22.0",
  "26.12.0",
  "22.22.999",
  "24.21.999",
  "26.11.999",
  "18.20.8",
  "20.20.1",
  "21.7.3",
  "23.11.1",
  "25.9.0",
  "27.0.0",
  "28.0.0",
];
const invalid = [
  "",
  "24",
  "24.22",
  "v24.22.1",
  " 24.22.1",
  "24.22.1 ",
  "24.22.1\n",
  "24.22.1.0",
  "024.22.1",
  "24.022.1",
  "24.22.01",
  "24.-1.1",
  "24.22.1+",
  "24.22.1+build..1",
  "24.22.1+build_1",
  "24.9007199254740992.0",
  "24.22.9007199254740992",
  "9007199254740992.22.1",
  "not-a-version",
  "22.23.4-rc.1",
  "24.22.1-rc.1",
  "26.12.1-rc.1",
  "24.23.0-nightly.20261022",
  "26.13.0-rc.1+build.1",
];

describe("unsupportedNodeMessage", () => {
  it.each(supported)("accepts supported stable release %s", (version) => {
    expect(unsupportedNodeMessage(version)).toBeNull();
  });

  it.each(unsupported)("rejects unpatched or unreviewed release %s", (version) => {
    expect(unsupportedNodeMessage(version)).toContain(JSON.stringify(version));
  });

  it.each(invalid)("rejects malformed or prerelease version %j", (version) => {
    expect(unsupportedNodeMessage(version)).toContain(JSON.stringify(version));
  });

  it("names the detected version and supported patched lines", () => {
    const message = unsupportedNodeMessage("24.18.0");
    expect(message).toContain('Detected Node version "24.18.0"');
    expect(message).toContain(NODE_VERSION_RANGE);
    expect(message).toContain("restart the host or MCP process");
  });
});

describe("assertSupportedNode", () => {
  const spy = () => {
    const written: string[] = [];
    const codes: number[] = [];
    return {
      deps: {
        write: (text: string) => written.push(text),
        exit: (code: number) => codes.push(code),
      },
      written,
      codes,
    };
  };

  it.each([...unsupported, ...invalid])("writes the refusal and exits 1 for %j", (version) => {
    const { deps, written, codes } = spy();
    assertSupportedNode(version, deps);
    expect(codes).toEqual([1]);
    expect(written).toEqual([`${unsupportedNodeMessage(version)}\n`]);
  });

  it.each(FLOORS)("returns silently on supported version %s", (version) => {
    const { deps, written, codes } = spy();
    assertSupportedNode(version, deps);
    expect(codes).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe("runtime policy declarations", () => {
  it("uses explicit bounded major ranges", () => {
    expect(NODE_VERSION_RANGE).toBe(">=22.23.4 <23.0.0 || >=24.22.1 <25.0.0 || >=26.12.1 <27.0.0");
  });

  it("package.json and MCPB manifest state the guard's range", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    const manifest = JSON.parse(read("manifest.json")) as {
      compatibility: { runtimes: { node: string } };
    };
    expect(pkg.engines.node).toBe(NODE_VERSION_RANGE);
    expect(manifest.compatibility.runtimes.node).toBe(NODE_VERSION_RANGE);
  });

  it("retains compilation targets independently of security patch floors", () => {
    for (const config of ["tsdown.config.ts", "tsdown.mcpb.config.ts"]) {
      expect(read(config)).toContain('target: "node22"');
    }
  });

  it("documents the complete runtime range", () => {
    expect(read("README.md")).toContain(NODE_VERSION_RANGE);
  });
});

describe("where the check is wired", () => {
  it("src/nodeVersion.ts imports nothing, by any spelling", () => {
    const src = read("src/nodeVersion.ts");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(|createRequire/);
  });

  it("source launchers use the guarded bootstrap", () => {
    expect(JSON.parse(read("package.json")).scripts.dev).toBe("tsx bin/entry.ts");
    for (const launcher of ["bin/console-mcp.sh", "bin/verify-mcp.sh"]) {
      expect(read(launcher)).toContain("tsx bin/entry.ts");
      expect(read(launcher)).not.toContain("tsx bin/console-mcp.ts");
    }
  });

  it("bin/entry.ts calls it before the first dynamic import", () => {
    const src = read("bin/entry.ts");
    const call = src.indexOf("assertSupportedNode()");
    const dynamicImport = src.indexOf("await import(");
    expect(call).toBeGreaterThan(-1);
    expect(dynamicImport).toBeGreaterThan(-1);
    expect(call).toBeLessThan(dynamicImport);
  });
});

// The CI workflow hand-writes the floors in its job pins and both matrices, and
// scripts/check-node-runtime.mjs carries its own copy; these tests tie every
// copy back to the table so a floor bump cannot leave one behind. The synced
// copy of this package (ts-sdks-incubation) has no .github/ of its own, so the
// workflow-reading tests skip there; the script ships in both repos.
describe("CI pins track the floor table", () => {
  const hasOwnCi = fs.existsSync(path.join(ROOT, ".github/workflows/ci.yml"));
  const ci = () => read(".github/workflows/ci.yml");

  it.skipIf(!hasOwnCi)("every non-matrix node-version is a supported version", () => {
    const pinned = [...ci().matchAll(/node-version:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);
    for (const version of pinned) {
      expect(unsupportedNodeMessage(version), `ci.yml pins ${version}`).toBeNull();
    }
  });

  it.skipIf(!hasOwnCi)("the node-floor matrix is refused and sits on the boundary", () => {
    // First matrix in the file is the node-floor (reject) job, second is
    // supported-runtimes (accept); the next assertions pin that meaning.
    const matrices = [...ci().matchAll(/node:\s*\[([^\]]*)\]/g)].map((m) =>
      [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? ""),
    );
    expect(matrices).toHaveLength(2);
    const [floorRows = [], supportedRows = []] = matrices;
    for (const version of floorRows) {
      expect(unsupportedNodeMessage(version), `node-floor row ${version}`).not.toBeNull();
    }
    for (const floor of FLOORS) {
      const [major = 0, minor = 0, patch = 0] = floor.split(".").map(Number);
      expect(floorRows, `one row exactly one patch below ${floor}`).toContain(
        `${major}.${minor}.${patch - 1}`,
      );
    }
    expect([...supportedRows].sort()).toEqual([...FLOORS].sort());
  });

  it("check-node-runtime.mjs carries the same floors", () => {
    const script = read("scripts/check-node-runtime.mjs");
    const listed = [...script.matchAll(/"(\d+\.\d+\.\d+)"/g)]
      .map((m) => m[1])
      .filter((v) => unsupportedNodeMessage(v) === null);
    expect(listed.sort()).toEqual([...FLOORS].sort());
  });
});
