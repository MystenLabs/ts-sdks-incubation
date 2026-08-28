import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installServer, resolveInstallRoot, serverBinPath } from "../src/installDir.js";

/**
 * The MCP entry we register is launched with access to the saved Console
 * credentials, so what it resolves to must not depend on the directory the agent
 * happens to be running in. `npx -y <spec>` does: it prefers a workspace-local
 * package of the same name, which is a credential-theft primitive for any project
 * that ships one — and is not hypothetical, it is how a name collision in this
 * very package was first noticed.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-installdir-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveInstallRoot", () => {
  it("honours XDG_DATA_HOME", () => {
    expect(resolveInstallRoot({ XDG_DATA_HOME: "/data" }, "linux")).toBe(
      path.join("/data", "walrus-console-mcp"),
    );
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    expect(resolveInstallRoot({ HOME: "/home/u" }, "linux")).toBe(
      path.join(os.homedir(), ".local", "share", "walrus-console-mcp"),
    );
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(resolveInstallRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "walrus-console-mcp"),
    );
  });

  it("returns an absolute path on every platform", () => {
    expect(path.isAbsolute(resolveInstallRoot({}, "darwin"))).toBe(true);
    expect(path.isAbsolute(resolveInstallRoot({}, "linux"))).toBe(true);
  });
});

describe("serverBinPath", () => {
  it("points at the bin shim inside the install root", () => {
    expect(serverBinPath("/root", "linux")).toBe(
      path.join("/root", "node_modules", ".bin", "walrus-console-mcp"),
    );
  });

  it("uses the .cmd shim on Windows", () => {
    expect(serverBinPath("C:\\root", "win32")).toBe(
      path.join("C:\\root", "node_modules", ".bin", "walrus-console-mcp.cmd"),
    );
  });

  it("is absolute, which is the entire point", () => {
    expect(path.isAbsolute(serverBinPath("/root", "linux"))).toBe(true);
  });
});

describe("installServer", () => {
  const spec = "@mysten-incubation/walrus-console-mcp@1.2.3";

  /** Stand in for npm: create the bin shim the real install would produce. */
  const fakeNpm = (calls: string[][]) => (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    const binDir = path.join(tmp, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "walrus-console-mcp"), "#!/bin/sh\n", { mode: 0o755 });
  };

  it("installs into the given root and returns the absolute bin path", () => {
    const calls: string[][] = [];

    const binPath = installServer(spec, { root: tmp, run: fakeNpm(calls), platform: "linux" });

    expect(binPath).toBe(path.join(tmp, "node_modules", ".bin", "walrus-console-mcp"));
    expect(fs.existsSync(binPath)).toBe(true);
  });

  it("scopes npm to that root so the caller's workspace cannot be picked up", () => {
    const calls: string[][] = [];

    installServer(spec, { root: tmp, run: fakeNpm(calls), platform: "linux" });

    const [call] = calls;
    expect(call?.[0]).toBe("npm");
    expect(call).toContain("--prefix");
    expect(call?.[call.indexOf("--prefix") + 1]).toBe(tmp);
    expect(call).toContain(spec);
  });

  it("disables npm lifecycle scripts so a malicious dependency cannot run install-time code", () => {
    const calls: string[][] = [];

    installServer(spec, { root: tmp, run: fakeNpm(calls), platform: "linux" });

    const [call] = calls;
    expect(call).toContain("--ignore-scripts");
  });

  it("throws when npm fails, rather than returning an unusable path", () => {
    expect(() =>
      installServer(spec, {
        root: tmp,
        run: () => {
          throw new Error("network down");
        },
        platform: "linux",
      }),
    ).toThrow(/network down|could not be installed/i);
  });

  it("throws when npm reports success but produces no bin", () => {
    // Registering a path that does not exist would leave a config that silently
    // fails to launch — worse than not registering at all.
    expect(() => installServer(spec, { root: tmp, run: () => {}, platform: "linux" })).toThrow(
      /walrus-console-mcp/,
    );
  });
});
