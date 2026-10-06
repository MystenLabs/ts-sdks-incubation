import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPORTED_BUNDLE_PLACEHOLDER,
  SAFE_NPX_PREFIX_ARG,
  stripBundleFromConfig,
  stripBundleFromCursorConfig,
} from "../src/cursorEntry.js";

// Inject an external edit at the filesystem boundary. All reads and writes
// remain real; the edit lands after the replacement is staged but before publish.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const BUNDLE = "eyJ2IjoxLCJhcGlLZXkiOiJoYnJfZXhhbXBsZSJ9";
const SPEC = "@mysten-incubation/walrus-console-mcp@0.1.0-beta.0";

/** The entry an Add to Cursor link writes, in the safe form. */
const linkEntry = (bundle = BUNDLE) => ({
  command: "npx",
  args: [SAFE_NPX_PREFIX_ARG, "-y", SPEC, "--import-bundle", bundle],
});

const OTHER = { command: "node", args: ["/opt/other/server.js", "--token", "unrelated"] };

/** The rewritten args of one server, failing loudly when nothing was rewritten. */
function argsOf(result: ReturnType<typeof stripBundleFromConfig>, name: string): unknown {
  expect(result).not.toBeNull();
  const servers = result?.config["mcpServers"] as Record<string, { args?: unknown }> | undefined;
  return servers?.[name]?.args;
}

describe("stripBundleFromConfig", () => {
  it("replaces the bundle with the placeholder and leaves everything else alone", () => {
    const config = { theme: "dark", mcpServers: { other: OTHER, "walrus-console": linkEntry() } };
    const result = stripBundleFromConfig(config, BUNDLE);

    expect(result?.entries).toEqual(["walrus-console"]);
    expect(result?.hardened).toEqual([]);
    expect(result?.config).toEqual({
      theme: "dark",
      mcpServers: {
        other: OTHER,
        "walrus-console": {
          command: "npx",
          args: [SAFE_NPX_PREFIX_ARG, "-y", SPEC, "--import-bundle", IMPORTED_BUNDLE_PLACEHOLDER],
        },
      },
    });
  });

  it("finds the entry by the bundle value, whatever the server is called", () => {
    const config = { mcpServers: { "renamed-by-user": linkEntry() } };
    expect(stripBundleFromConfig(config, BUNDLE)?.entries).toEqual(["renamed-by-user"]);
  });

  it("strips the --import-bundle=<value> spelling too", () => {
    const config = {
      mcpServers: {
        w: { command: "npx", args: [SAFE_NPX_PREFIX_ARG, "-y", SPEC, `--import-bundle=${BUNDLE}`] },
      },
    };
    const args = argsOf(stripBundleFromConfig(config, BUNDLE), "w") as string[];
    expect(args.at(-1)).toBe(`--import-bundle=${IMPORTED_BUNDLE_PLACEHOLDER}`);
  });

  it("returns null when no entry carries this bundle", () => {
    const config = { mcpServers: { other: OTHER, w: linkEntry("a-different-bundle-value") } };
    expect(stripBundleFromConfig(config, BUNDLE)).toBeNull();
  });

  it("returns null for a config without a usable mcpServers map", () => {
    expect(stripBundleFromConfig({}, BUNDLE)).toBeNull();
    expect(stripBundleFromConfig({ mcpServers: [] }, BUNDLE)).toBeNull();
    expect(stripBundleFromConfig({ mcpServers: { w: "not an entry" } }, BUNDLE)).toBeNull();
  });

  it("adds the prefix to a plain npx entry it strips, so later starts cannot be shadowed", () => {
    const config = {
      mcpServers: { w: { command: "npx", args: ["-y", SPEC, "--import-bundle", BUNDLE] } },
    };
    const result = stripBundleFromConfig(config, BUNDLE);
    expect(result?.hardened).toEqual(["w"]);
    expect(argsOf(result, "w")).toEqual([
      SAFE_NPX_PREFIX_ARG,
      "-y",
      SPEC,
      "--import-bundle",
      IMPORTED_BUNDLE_PLACEHOLDER,
    ]);
  });

  it.each(["npx.cmd", "C:\\Program Files\\nodejs\\npx.cmd", "/usr/local/bin/npx"])(
    "recognises %s as npx",
    (command) => {
      const config = {
        mcpServers: { w: { command, args: ["-y", SPEC, "--import-bundle", BUNDLE] } },
      };
      expect(stripBundleFromConfig(config, BUNDLE)?.hardened).toEqual(["w"]);
    },
  );

  it("keeps an existing prefix, and never adds one to a command that is not npx", () => {
    const withPrefix = {
      mcpServers: {
        w: { command: "npx", args: ["--prefix", "/x", "-y", SPEC, "--import-bundle", BUNDLE] },
      },
    };
    expect(stripBundleFromConfig(withPrefix, BUNDLE)?.hardened).toEqual([]);

    const absolute = {
      mcpServers: {
        w: { command: "/home/u/.local/bin/walrus-console-mcp", args: ["--import-bundle", BUNDLE] },
      },
    };
    const result = stripBundleFromConfig(absolute, BUNDLE);
    expect(result?.hardened).toEqual([]);
    expect(argsOf(result, "w")).toEqual(["--import-bundle", IMPORTED_BUNDLE_PLACEHOLDER]);
  });

  it("never edits a server that did not carry the bundle, even a plain npx one", () => {
    const plainOther = { command: "npx", args: ["-y", "some-other-server"] };
    const config = { mcpServers: { plain: plainOther, w: linkEntry() } };
    const servers = stripBundleFromConfig(config, BUNDLE)?.config["mcpServers"] as Record<
      string,
      unknown
    >;
    expect(servers["plain"]).toEqual(plainOther);
  });

  it.each([
    ["a prefix naming the workspace", ["--prefix=.", "-y", SPEC, "--import-bundle", BUNDLE]],
    [
      "a relative prefix as two tokens",
      ["--prefix", "node_modules", "-y", SPEC, "--import-bundle", BUNDLE],
    ],
    ["a prefix after the package spec", ["-y", SPEC, "--prefix=/opt/x", "--import-bundle", BUNDLE]],
    [
      "an unrelated flag that starts with --prefix",
      ["--prefixless", "-y", SPEC, "--import-bundle", BUNDLE],
    ],
  ])("does not count %s as hardened", (_label, args) => {
    const result = stripBundleFromConfig({ mcpServers: { w: { command: "npx", args } } }, BUNDLE);
    expect(result?.hardened).toEqual(["w"]);
    const next = argsOf(result, "w") as string[];
    expect(next[0]).toBe(SAFE_NPX_PREFIX_ARG);
    // npm sees exactly one prefix before the package spec, and it is the safe one.
    const beforeSpec = next.slice(0, next.indexOf(SPEC));
    expect(beforeSpec.filter((a) => a === "--prefix" || a.startsWith("--prefix="))).toEqual([
      SAFE_NPX_PREFIX_ARG,
    ]);
    expect(next.at(-1)).toBe(IMPORTED_BUNDLE_PLACEHOLDER);
  });

  it("keeps the other npm options and the server's own args in place when hardening", () => {
    const args = [
      "--prefix=.",
      "--package",
      "x@1",
      "-y",
      SPEC,
      "--prefix=/opt/x",
      "--import-bundle",
      BUNDLE,
    ];
    const result = stripBundleFromConfig({ mcpServers: { w: { command: "npx", args } } }, BUNDLE);
    expect(argsOf(result, "w")).toEqual([
      SAFE_NPX_PREFIX_ARG,
      "--package",
      "x@1",
      "-y",
      SPEC,
      "--prefix=/opt/x",
      "--import-bundle",
      IMPORTED_BUNDLE_PLACEHOLDER,
    ]);
  });

  // Absolute by the running OS's rules, the ones npm resolves the prefix by.
  const ABSOLUTE = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  const FOREIGN_ABSOLUTE = process.platform === "win32" ? "/home/u" : "C:\\Users\\u";

  it.each([SAFE_NPX_PREFIX_ARG, `--prefix=${ABSOLUTE}`])(
    "treats %s before the package spec as hardened",
    (prefix) => {
      const config = {
        mcpServers: {
          w: { command: "npx", args: [prefix, "-y", SPEC, "--import-bundle", BUNDLE] },
        },
      };
      expect(stripBundleFromConfig(config, BUNDLE)?.hardened).toEqual([]);
    },
  );

  it.each([
    ["a safe prefix followed by an unsafe one", [SAFE_NPX_PREFIX_ARG, "--prefix=."]],
    ["an unsafe prefix followed by a safe one", ["--prefix=.", SAFE_NPX_PREFIX_ARG]],
    ["the -C shorthand", ["-C", "."]],
    ["an abbreviation npm expands", ["--prefi=."]],
    ["another OS's absolute path", [`--prefix=${FOREIGN_ABSOLUTE}`]],
    ["a variable other than ${userHome}", ["--prefix=${workspaceFolder}"]],
    ["npm's negated form", ["--no-prefix"]],
    ["a negation after a safe prefix", [SAFE_NPX_PREFIX_ARG, "--no-prefix"]],
    ["an abbreviated negation", ["--no-prefi"]],
  ])("replaces every prefix when given %s", (_label, prefixArgs) => {
    const args = [...prefixArgs, "-y", SPEC, "--import-bundle", BUNDLE];
    const result = stripBundleFromConfig({ mcpServers: { w: { command: "npx", args } } }, BUNDLE);
    expect(result?.hardened).toEqual(["w"]);
    expect(argsOf(result, "w")).toEqual([
      SAFE_NPX_PREFIX_ARG,
      "-y",
      SPEC,
      "--import-bundle",
      IMPORTED_BUNDLE_PLACEHOLDER,
    ]);
  });

  it("keeps a server named __proto__", () => {
    // JSON.parse makes `__proto__` an own key; an object literal cannot.
    const config = JSON.parse(
      `{"mcpServers":{"__proto__":${JSON.stringify(OTHER)},"w":${JSON.stringify(linkEntry())}}}`,
    ) as Record<string, unknown>;
    const out = JSON.parse(JSON.stringify(stripBundleFromConfig(config, BUNDLE)?.config));
    expect(Object.keys(out.mcpServers)).toEqual(["__proto__", "w"]);
    expect(out.mcpServers["__proto__"]).toEqual(OTHER);
  });
});

describe("stripBundleFromCursorConfig", () => {
  let tmpDir: string;
  let mcpJson: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cursor-entry-test-"));
    mcpJson = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(mcpJson), { recursive: true });
    originalEnv = { ...process.env };
    // The lock lives in our config directory; keep it inside the temp dir on
    // every platform (APPDATA on Windows, XDG_CONFIG_HOME elsewhere).
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir, APPDATA: tmpDir };
  });

  afterEach(() => {
    vi.mocked(fs.fsyncSync).mockClear();
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites the file so the bundle is gone and other servers survive", () => {
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { other: OTHER, w: linkEntry() } }));

    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
      kind: "stripped",
      entries: ["w"],
      hardened: [],
    });
    const text = fs.readFileSync(mcpJson, "utf-8");
    expect(text).not.toContain(BUNDLE);
    expect(JSON.parse(text).mcpServers.other).toEqual(OTHER);
  });

  it.skipIf(process.platform === "win32").each(["absolute", "relative", "chain", "directory"])(
    "cleans through a %s symlink, keeping the link, target mode and other settings",
    (kind) => {
      const dotfiles = path.join(tmpDir, "dotfiles");
      fs.mkdirSync(dotfiles);
      const target = path.join(dotfiles, "mcp.json");
      fs.writeFileSync(
        target,
        JSON.stringify({ theme: "dark", mcpServers: { other: OTHER, w: linkEntry() } }),
      );
      fs.chmodSync(target, 0o640);
      let link = mcpJson;
      let destination = target;
      if (kind === "relative") destination = path.relative(path.dirname(mcpJson), target);
      if (kind === "chain") {
        destination = path.join(tmpDir, "intermediate.json");
        fs.symlinkSync(target, destination);
      }
      if (kind === "directory") {
        fs.rmdirSync(path.dirname(mcpJson));
        link = path.dirname(mcpJson);
        destination = dotfiles;
      }
      fs.symlinkSync(destination, link);

      expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
        kind: "stripped",
        entries: ["w"],
        hardened: [],
      });
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(destination);
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
      const cleaned = fs.readFileSync(target, "utf-8");
      expect(cleaned).not.toContain(BUNDLE);
      expect(JSON.parse(cleaned)).toEqual({
        theme: "dark",
        mcpServers: { other: OTHER, w: linkEntry(IMPORTED_BUNDLE_PLACEHOLDER) },
      });
      expect(fs.readFileSync(mcpJson, "utf-8")).toBe(cleaned);
      expect(fs.readdirSync(dotfiles)).toEqual(["mcp.json"]);
    },
  );

  it("leaves the file byte-for-byte alone when the bundle is not in it", () => {
    const original = JSON.stringify({ mcpServers: { other: OTHER } });
    fs.writeFileSync(mcpJson, original);
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
      kind: "not-found",
      cleanedEntry: false,
    });
    expect(fs.readFileSync(mcpJson, "utf-8")).toBe(original);
  });

  it("reports an entry already holding the placeholder", () => {
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ mcpServers: { w: linkEntry(IMPORTED_BUNDLE_PLACEHOLDER) } }),
    );
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
      kind: "not-found",
      cleanedEntry: true,
    });
  });

  it("reports a missing file without creating one", () => {
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({ kind: "missing-file" });
    expect(fs.existsSync(mcpJson)).toBe(false);
  });

  it("refuses to rewrite a file it cannot parse, and never quotes it", () => {
    const original = `{ "mcpServers": { "w": { "args": ["--import-bundle", "${BUNDLE}"] } `;
    fs.writeFileSync(mcpJson, original);
    const outcome = stripBundleFromCursorConfig(mcpJson, BUNDLE);
    expect(outcome.kind).toBe("unreadable");
    expect(JSON.stringify(outcome)).not.toContain(BUNDLE);
    expect(fs.readFileSync(mcpJson, "utf-8")).toBe(original);
  });

  it("refuses a non-regular config without reading or replacing it", () => {
    fs.mkdirSync(mcpJson);
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
      kind: "unreadable",
      reason: "it is not a regular file",
    });
    expect(fs.statSync(mcpJson).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a dangling link without replacing it", () => {
    const missing = path.join(tmpDir, "missing.json");
    fs.symlinkSync(missing, mcpJson);
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE).kind).toBe("unreadable");
    expect(fs.readlinkSync(mcpJson)).toBe(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("leaves a concurrent config edit untouched and removes the staged replacement", async () => {
    const original = JSON.stringify({ mcpServers: { w: linkEntry() } });
    const updated = JSON.stringify({ theme: "new", mcpServers: { other: OTHER, w: linkEntry() } });
    fs.writeFileSync(mcpJson, original);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      actual.fsyncSync(fd);
      fs.writeFileSync(mcpJson, updated);
    });
    expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
      kind: "unreadable",
      reason: "it changed during credential cleanup; restart the server to retry",
    });
    expect(fs.readFileSync(mcpJson, "utf-8")).toBe(updated);
    expect(fs.readdirSync(path.dirname(mcpJson))).toEqual(["mcp.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "leaves both targets untouched if a link is repointed",
    async () => {
      const original = JSON.stringify({ mcpServers: { w: linkEntry() } });
      const target = path.join(tmpDir, "target.json");
      const newerTarget = path.join(tmpDir, "newer.json");
      fs.writeFileSync(target, original);
      fs.writeFileSync(newerTarget, original);
      fs.symlinkSync(target, mcpJson);
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
        actual.fsyncSync(fd);
        fs.unlinkSync(mcpJson);
        fs.symlinkSync(newerTarget, mcpJson);
      });
      expect(stripBundleFromCursorConfig(mcpJson, BUNDLE)).toEqual({
        kind: "unreadable",
        reason: "it changed during credential cleanup; restart the server to retry",
      });
      expect(fs.readlinkSync(mcpJson)).toBe(newerTarget);
      expect(fs.readFileSync(target, "utf-8")).toBe(original);
      expect(fs.readFileSync(newerTarget, "utf-8")).toBe(original);
      expect(fs.readdirSync(tmpDir).some((name) => name.endsWith(".tmp"))).toBe(false);
    },
  );

  it("releases its lock", () => {
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { w: linkEntry() } }));
    stripBundleFromCursorConfig(mcpJson, BUNDLE);
    const configDir = path.join(tmpDir, "walrus-console-mcp");
    expect(fs.readdirSync(configDir).filter((n) => n.includes("lock"))).toEqual([]);
  });
});
