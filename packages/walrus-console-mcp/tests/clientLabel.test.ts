import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_CLIENT_SPECS,
  CURSOR_STDIO_ARGS,
  SERVER_NAME,
  cliClient,
  clientLabelEnv,
  jsonFileClient,
  upsertMcpServer,
  type CommandRunner,
} from "../src/clients";
import { ConsoleConfigTag } from "../src/config";
import { CLIENT_LABEL_ENV } from "../src/consoleClientHeader";
import {
  enableRuntimeAttribution,
  runtimeClientHeaders,
  setReportedClientName,
} from "../src/consoleClientHeader";
import { ConsoleApiClient, fetchWithClientHeader } from "../src/console/ConsoleApiClient";
import { probeKey } from "../src/credentials";
import type { BucketId, FileId } from "../src/console/types";

/**
 * Two facts reach Console as separate headers: the install-target label,
 * which the installer writes into each harness's server entry, and a runtime-only
 * marker, which only the running server sends. The installer's probe must carry
 * neither, even from a shell that inherits `WALRUS_MCP_CLIENT`.
 */

const BIN = "/usr/local/lib/walrus-console-mcp/bin/console-mcp.js";

describe("runtimeClientHeaders", () => {
  // The flag is module state, so each case loads a fresh copy of the module.
  async function fresh() {
    vi.resetModules();
    return import("../src/consoleClientHeader");
  }

  it("is empty until the running server turns attribution on", async () => {
    const mod = await fresh();

    expect(mod.runtimeClientHeaders({ [CLIENT_LABEL_ENV]: "cursor" })).toEqual({});
  });

  it("sends the marker and the label once the server has started", async () => {
    const mod = await fresh();
    mod.enableRuntimeAttribution();

    expect(mod.runtimeClientHeaders({ [CLIENT_LABEL_ENV]: "cursor" })).toEqual({
      "X-Console-Client-Runtime": "1",
      "X-Console-Client-Target": "cursor",
    });
  });

  it("sends the marker alone when no label is set, never a wrong label", async () => {
    const mod = await fresh();
    mod.enableRuntimeAttribution();

    expect(mod.runtimeClientHeaders({})).toEqual({ "X-Console-Client-Runtime": "1" });
    expect(mod.runtimeClientHeaders({ [CLIENT_LABEL_ENV]: "" })).toEqual({
      "X-Console-Client-Runtime": "1",
    });
  });

  it("drops a label that cannot travel as a header value", async () => {
    const mod = await fresh();
    mod.enableRuntimeAttribution();

    expect(mod.runtimeClientHeaders({ [CLIENT_LABEL_ENV]: "café" })).toEqual({
      "X-Console-Client-Runtime": "1",
    });
  });

  it("forwards the harness's reported name when clientInfo supplied one", async () => {
    const mod = await fresh();
    mod.enableRuntimeAttribution();
    mod.setReportedClientName("Cursor");

    expect(mod.runtimeClientHeaders({})).toEqual({
      "X-Console-Client-Runtime": "1",
      "X-Console-Client-Name": "Cursor",
    });
  });
});

describe("install-target label in the registered entries", () => {
  // Claude's `--env <env...>` is variadic: a name placed before it is read as a
  // second KEY=VALUE and the add fails. The name must come first.
  it("claude-code writes the label through --env, after the name", () => {
    const spec = CLI_CLIENT_SPECS.find((s) => s.id === "claude-code")!;

    expect(spec.addArgs(SERVER_NAME, BIN, clientLabelEnv("claude-code"))).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      SERVER_NAME,
      "--env",
      "WALRUS_MCP_CLIENT=claude-code",
      "--",
      BIN,
    ]);
  });

  it("codex writes the label through --env", () => {
    const spec = CLI_CLIENT_SPECS.find((s) => s.id === "codex")!;

    expect(spec.addArgs(SERVER_NAME, BIN, clientLabelEnv("codex"))).toEqual([
      "mcp",
      "add",
      "--env",
      "WALRUS_MCP_CLIENT=codex",
      SERVER_NAME,
      "--",
      BIN,
    ]);
  });

  it("gemini writes the label through -e, with no -- separator", () => {
    const spec = CLI_CLIENT_SPECS.find((s) => s.id === "gemini")!;

    expect(spec.addArgs(SERVER_NAME, BIN, clientLabelEnv("gemini"))).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "-e",
      "WALRUS_MCP_CLIENT=gemini",
      SERVER_NAME,
      BIN,
    ]);
  });

  it("the CLI register call carries the label for its own client", () => {
    const calls: { bin: string; args: string[] }[] = [];
    const run: CommandRunner = (bin, args) => {
      calls.push({ bin, args });
    };
    const client = cliClient(
      CLI_CLIENT_SPECS.find((s) => s.id === "codex")!,
      { run },
    );

    client.register(BIN);

    expect(calls[1]?.args).toContain("WALRUS_MCP_CLIENT=codex");
  });

  it("upsertMcpServer adds env only when a label is given", () => {
    const labelled = upsertMcpServer({}, SERVER_NAME, BIN, [], clientLabelEnv("cursor"));
    const bare = upsertMcpServer({}, SERVER_NAME, BIN);

    expect(labelled.mcpServers[SERVER_NAME]).toEqual({
      command: BIN,
      args: [],
      env: { WALRUS_MCP_CLIENT: "cursor" },
    });
    expect(bare.mcpServers[SERVER_NAME]).toEqual({ command: BIN, args: [] });
    expect(Object.hasOwn(bare.mcpServers[SERVER_NAME]!, "env")).toBe(false);
  });

  it("the Cursor config file carries the label in its server entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comg1120-"));
    const file = path.join(dir, "mcp.json");
    try {
      const client = jsonFileClient({
        id: "cursor",
        label: "Cursor",
        args: CURSOR_STDIO_ARGS,
        env: clientLabelEnv("cursor"),
        configPath: () => file,
        detect: () => true,
      });

      client.register(BIN);

      const written = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(written.mcpServers[SERVER_NAME]).toEqual({
        command: BIN,
        args: [...CURSOR_STDIO_ARGS],
        env: { WALRUS_MCP_CLIENT: "cursor" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the probe never carries attribution", () => {
  const baseUrl = "https://api.example.test";
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[CLIENT_LABEL_ENV];
    // The installer can inherit the label from a harness-spawned shell.
    process.env[CLIENT_LABEL_ENV] = "cursor";
    enableRuntimeAttribution();
    setReportedClientName("Cursor");
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[CLIENT_LABEL_ENV];
    else process.env[CLIENT_LABEL_ENV] = previous;
  });

  it("sends neither the marker nor the label, even with the server's state set", async () => {
    let headers = new Headers();
    const fake = (async (_url: string | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await probeKey("api", "hbr_x", baseUrl, fake)).toBe("ok");
    expect(headers.get("x-console-client")).toBe("mcp");
    expect(headers.get("x-console-client-runtime")).toBeNull();
    expect(headers.get("x-console-client-target")).toBeNull();
    expect(headers.get("x-console-client-name")).toBeNull();
  });
});

describe("the running server's Console calls", () => {
  interface Seen {
    headers: Record<string, string>;
  }

  function harness(seen: Seen[]) {
    const stub = HttpClient.make((request) => {
      seen.push({ headers: { ...request.headers } });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    return ConsoleApiClient.Default.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ConsoleConfigTag, {
            apiKey: Redacted.make("hbr_test_key"),
            servicePrivateKey: Redacted.make(""),
            adminKey: Redacted.make("hbradm_test_key"),
            adminServicePrivateKey: Redacted.make(""),
            baseUrl: "https://api.example.test",
            webAccountAddress: "",
            keyAdminAddress: "",
          }),
          Layer.succeed(HttpClient.HttpClient, stub),
        ),
      ),
    );
  }

  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[CLIENT_LABEL_ENV];
    process.env[CLIENT_LABEL_ENV] = "cursor";
    enableRuntimeAttribution();
    setReportedClientName("Cursor");
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[CLIENT_LABEL_ENV];
    else process.env[CLIENT_LABEL_ENV] = previous;
  });

  it("send the marker, the label and the reported name, beside the existing headers", async () => {
    const seen: Seen[] = [];
    const layer = harness(seen);

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.listSpaces();
      }).pipe(Effect.provide(layer)),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["x-console-client"]).toBe("mcp");
    expect(seen[0]?.headers["x-console-client-runtime"]).toBe("1");
    expect(seen[0]?.headers["x-console-client-target"]).toBe("cursor");
    expect(seen[0]?.headers["x-console-client-name"]).toBe("Cursor");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer hbr_test_key");
  });

  // Upload and download build their own fetch calls, outside both HttpClient lanes,
  // so the lane tests above cannot reach them.
  describe("upload and download fetches", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("upload sends the marker, the label and the reported name", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "file-1" } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.uploadBucketFile(
            "bucket-1" as BucketId,
            new Uint8Array([1, 2, 3]),
            "note.txt",
          );
        }).pipe(Effect.provide(harness([]))),
      );

      const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Console-Client-Runtime"]).toBe("1");
      expect(headers["X-Console-Client-Target"]).toBe("cursor");
      expect(headers["X-Console-Client-Name"]).toBe("Cursor");
    });

    it("download sends the marker, the label and the reported name on the first hop", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "3" },
        }),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.downloadBucketFile("bucket-1" as BucketId, "file-1" as FileId);
        }).pipe(Effect.provide(harness([]))),
      );

      const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Console-Client-Runtime"]).toBe("1");
      expect(headers["X-Console-Client-Target"]).toBe("cursor");
      expect(headers["X-Console-Client-Name"]).toBe("Cursor");
    });
  });
});

// The Seal SDK's `fetch_key` requests reach Console's `/api/*` auth through this wrapper,
// so they carry the same attribution as the client's own lanes.
describe("the Seal fetch_key wrapper", () => {
  it("sends the marker and the label beside X-Console-Client", async () => {
    enableRuntimeAttribution();
    const saved = process.env[CLIENT_LABEL_ENV];
    process.env[CLIENT_LABEL_ENV] = "codex";
    try {
      let headers = new Headers();
      const base = (async (_url: string | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch;

      await fetchWithClientHeader(base)("https://key.example.test/fetch_key", {
        headers: { Authorization: "Bearer hbr_seal" },
      });

      expect(headers.get("x-console-client")).toBe("mcp");
      expect(headers.get("x-console-client-runtime")).toBe("1");
      expect(headers.get("x-console-client-target")).toBe("codex");
      expect(headers.get("authorization")).toBe("Bearer hbr_seal");
    } finally {
      if (saved === undefined) delete process.env[CLIENT_LABEL_ENV];
      else process.env[CLIENT_LABEL_ENV] = saved;
    }
  });
});

describe("runtimeClientHeaders with the label unset", () => {
  it("returns the marker only", () => {
    enableRuntimeAttribution();
    const saved = process.env[CLIENT_LABEL_ENV];
    delete process.env[CLIENT_LABEL_ENV];
    try {
      expect(runtimeClientHeaders()).not.toHaveProperty("X-Console-Client-Target");
    } finally {
      if (saved !== undefined) process.env[CLIENT_LABEL_ENV] = saved;
    }
  });
});
