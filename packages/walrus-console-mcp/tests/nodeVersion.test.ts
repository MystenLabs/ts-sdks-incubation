import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_NODE_MAJOR,
  assertSupportedNode,
  nodeMajor,
  unsupportedNodeMessage,
} from "../src/nodeVersion.js";

/**
 * COMG-1036 item 1. Two halves: the refusal itself, and the guarantee that the
 * five places stating the floor still agree with each other. They disagreed
 * once already (manifest >=22, tsdown node22, engines >=24), which is why the
 * number lives in one exported constant now.
 */

const ROOT = path.join(__dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf-8");
const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

describe("nodeMajor", () => {
  it("reads the major out of a process.versions.node string", () => {
    expect(nodeMajor("24.0.0")).toBe(24);
    expect(nodeMajor("20.19.6")).toBe(20);
    expect(nodeMajor(" 25.8.1 ")).toBe(25);
  });

  it("returns null for anything it cannot read as one", () => {
    for (const value of ["", "24", "v24.0.0", "next", "x.y.z"]) {
      expect(nodeMajor(value)).toBeNull();
    }
  });
});

describe("unsupportedNodeMessage", () => {
  it("passes the floor and everything above it", () => {
    expect(unsupportedNodeMessage(`${MIN_NODE_MAJOR}.0.0`)).toBeNull();
    expect(unsupportedNodeMessage(`${MIN_NODE_MAJOR + 1}.8.1`)).toBeNull();
  });

  // The whole complaint: on an old Node the first symptom is a SyntaxError
  // about `styleText` from a bundled chunk, which names neither the version
  // that is running nor the one that is required.
  it("names both the floor and the running version", () => {
    const message = unsupportedNodeMessage("20.19.6");
    expect(message).toContain(`Node ${MIN_NODE_MAJOR}`);
    expect(message).toContain("20.19.6");
  });

  it("refuses every major below the floor", () => {
    for (let major = 12; major < MIN_NODE_MAJOR; major++) {
      expect(unsupportedNodeMessage(`${major}.0.0`)).not.toBeNull();
    }
  });

  // A runtime whose version cannot be read is one we cannot judge. Refusing to
  // start on a guess is worse than running somewhere that turns out to be fine.
  it("fails open on a version it cannot parse", () => {
    expect(unsupportedNodeMessage("not-a-version")).toBeNull();
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

  it("writes the refusal and exits 1", () => {
    const { deps, written, codes } = spy();
    assertSupportedNode("20.19.6", deps);
    expect(codes).toEqual([1]);
    expect(written.join("")).toContain(`Node ${MIN_NODE_MAJOR}`);
  });

  it("returns silently on a supported version", () => {
    const { deps, written, codes } = spy();
    assertSupportedNode(`${MIN_NODE_MAJOR}.3.0`, deps);
    expect(codes).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe("one floor, five declarations", () => {
  it("package.json engines.node", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });

  it("manifest.json compatibility.runtimes.node", () => {
    const manifest = JSON.parse(read("manifest.json")) as {
      compatibility: { runtimes: { node: string } };
    };
    expect(manifest.compatibility.runtimes.node).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
  });

  it("both tsdown targets", () => {
    for (const config of ["tsdown.config.ts", "tsdown.mcpb.config.ts"]) {
      expect(read(config)).toContain(`target: "node${MIN_NODE_MAJOR}"`);
    }
  });

  // The three cases below read the development repo's own CI workflow, which is
  // not mirrored into the ts-sdks-incubation workspace (the monorepo has its own
  // workflows at the repo root), so they only run where the file exists.
  const hasOwnCi = fs.existsSync(path.join(ROOT, ".github/workflows/ci.yml"));

  // Every `node-version:` in ci.yml, whatever form it is written in. ci.yml pins
  // it in several jobs, and a `toContain`, or a regex that only knows the quoted
  // integer form, stays green with one of them stale as `24`, "24.x" or "lts/*".
  // The one exception is node-floor's `${{ matrix.node }}`, which runs below the
  // floor by design.
  it.skipIf(!hasOwnCi)("every Node version CI pins is the floor", () => {
    const pinned = [...read(".github/workflows/ci.yml").matchAll(/node-version:(.*)/g)]
      .map((m) => unquote((m[1] ?? "").replace(/\s#.*$/, "")))
      .filter((value) => !/^\$\{\{\s*matrix\.node\s*\}\}$/.test(value));
    expect(pinned.length).toBeGreaterThan(0);
    expect([...new Set(pinned)]).toEqual([String(MIN_NODE_MAJOR)]);
  });

  // The node-floor job carries the floor twice more, in shell rather than YAML:
  // the version it refuses to run at or above, and the text it greps the refusal
  // for. The second is tied to the message the module actually emits, so a
  // reworded refusal fails here rather than in a CI job nobody reads.
  it.skipIf(!hasOwnCi)(
    "the node-floor job's own two copies of the floor track the constant",
    () => {
      const ci = read(".github/workflows/ci.yml");
      const pattern = `needs Node ${MIN_NODE_MAJOR} or newer`;
      expect(unsupportedNodeMessage(`${MIN_NODE_MAJOR - 1}.0.0`)).toContain(pattern);
      expect(ci).toContain(pattern);
      expect(ci).toContain(`-ge ${MIN_NODE_MAJOR} ]`);
    },
  );

  // The invariant the job rests on: every row it runs must be below the floor,
  // or the job would demand a refusal from a version that is supposed to work.
  it.skipIf(!hasOwnCi)("every node-floor matrix row is below the floor", () => {
    const matrix = /node:\s*\[([^\]]*)\]/.exec(read(".github/workflows/ci.yml"))?.[1] ?? "";
    const rows = matrix.split(",").map(unquote).filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Number(row), row).toBeLessThan(MIN_NODE_MAJOR);
  });

  it("the README tells a reader which Node they need", () => {
    expect(read("README.md")).toContain(`Node ${MIN_NODE_MAJOR}`);
  });
});

describe("where the check is wired", () => {
  // It has to run on the Node it exists to refuse, so it may not import
  // anything: `styleText` is the very export that is missing there.
  it("src/nodeVersion.ts imports nothing, by any spelling", () => {
    const src = read("src/nodeVersion.ts");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(|createRequire/);
  });

  // Placement is the whole point. Both verbs reach their code through a dynamic
  // `import()`, which is where the link-time SyntaxError lands, so the call has
  // to come first.
  it("bin/console-mcp.ts calls it before the first dynamic import", () => {
    const src = read("bin/console-mcp.ts");
    const call = src.indexOf("assertSupportedNode()");
    const dynamicImport = src.indexOf("await import(");
    expect(call).toBeGreaterThan(-1);
    expect(dynamicImport).toBeGreaterThan(-1);
    expect(call).toBeLessThan(dynamicImport);
  });
});
