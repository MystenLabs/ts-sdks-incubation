import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigDir,
  getConfigFilePath,
  loadConfigFile,
  mergeConfigFile,
} from "../src/configFile.js";

/**
 * mergeConfigFile is a read-merge-write across processes: `install` and `config`
 * both call it, and saveConfigFile replaces the whole file. Without coordination
 * the later writer wins and silently drops the earlier one's credential.
 *
 * These drive real child processes, because an in-process test cannot observe an
 * inter-process race — the thing under test is the file lock, not the merge.
 */

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-lock-test-"));
  originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Absolute path to src/configFile.ts, so a child can import it directly. */
const MODULE = path.resolve(__dirname, "../src/configFile.ts");

describe("mergeConfigFile — concurrent writers", () => {
  it("keeps every writer's field when four processes merge at once", async () => {
    const fields = ["apiKey", "servicePrivateKey", "adminKey", "adminServicePrivateKey"];
    const startAt = Date.now() + 1200;
    const { spawn } = await import("node:child_process");

    const procs = fields.map((field) => {
      const file = path.join(tmpDir, `merge-${field}.mts`);
      fs.writeFileSync(
        file,
        `import { mergeConfigFile } from ${JSON.stringify(MODULE)};\n` +
          `while (Date.now() < ${startAt}) {}\n` +
          `mergeConfigFile({ ${field}: ${JSON.stringify(`value-of-${field}`)} });\n`,
      );
      return spawn("npx", ["tsx", file], {
        env: { ...process.env, XDG_CONFIG_HOME: tmpDir },
        stdio: "ignore",
      });
    });

    const codes = await Promise.all(
      procs.map((p) => new Promise<number | null>((resolve) => p.on("exit", resolve))),
    );
    expect(codes.every((c) => c === 0)).toBe(true);

    const saved = loadConfigFile();
    for (const field of fields) {
      expect(saved[field as keyof typeof saved]).toBe(`value-of-${field}`);
    }
  }, 60_000);

  it("removes the lock file once the merge completes", () => {
    mergeConfigFile({ apiKey: "hbr_x" });
    const leftovers = fs.readdirSync(getConfigDir()).filter((n) => n.includes("lock"));
    expect(leftovers).toEqual([]);
  });

  it("reclaims a lock left behind by a process that is gone", () => {
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    // PID 2^22 is above the maximum on Linux and macOS, so it cannot be running.
    fs.writeFileSync(
      path.join(getConfigDir(), ".config.json.lock"),
      JSON.stringify({ pid: 4194304, at: Date.now() }),
    );

    // Must not hang or throw: the holder is provably dead, so the lock is stale.
    const merged = mergeConfigFile({ apiKey: "hbr_after_stale_lock" });
    expect(merged.apiKey).toBe("hbr_after_stale_lock");
    expect(loadConfigFile().apiKey).toBe("hbr_after_stale_lock");
  });

  it("does not take the lock from a holder that is still running", () => {
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    // Our own pid is provably alive, and the hold is far older than a read plus
    // a rename should ever take — a stalled holder, not a dead one. Suspending
    // the machine mid-merge produces exactly this record.
    fs.writeFileSync(
      path.join(getConfigDir(), ".config.json.lock"),
      JSON.stringify({ pid: process.pid, nonce: "held-elsewhere", at: Date.now() - 120_000 }),
    );

    // A running holder may still be between its read and its write, so the only
    // safe answer is the loud timeout. Reclaiming here would put two writers in
    // the critical section and drop one of their credentials.
    expect(() => mergeConfigFile({ apiKey: "hbr_should_not_win" })).toThrow(/Timed out/);
    expect(loadConfigFile().apiKey).toBeUndefined();
  }, 20_000);

  it("reclaims a corrupt lock rather than blocking forever", () => {
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(getConfigDir(), ".config.json.lock"), "not json");

    const merged = mergeConfigFile({ apiKey: "hbr_after_corrupt_lock" });
    expect(merged.apiKey).toBe("hbr_after_corrupt_lock");
  });

  // POSIX only: the stall is produced with a FIFO, which Windows has no analogue for.
  it.skipIf(process.platform === "win32")(
    "leaves alone a lock that was reclaimed from it mid-merge",
    async () => {
      const { execFileSync, spawn } = await import("node:child_process");
      fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });

      // loadConfigFile runs inside the lock, so making the config file a FIFO
      // parks the child there until we say otherwise — a deterministic stand-in
      // for the suspended laptop or wedged network mount that leaves a live
      // holder's lock looking old.
      const configPath = getConfigFilePath();
      execFileSync("mkfifo", [configPath]);

      const script = path.join(tmpDir, "stalled-merge.mts");
      fs.writeFileSync(
        script,
        `import { mergeConfigFile } from ${JSON.stringify(MODULE)};\n` +
          `mergeConfigFile({ apiKey: "hbr_stalled" });\n`,
      );
      const child = spawn("npx", ["tsx", script], {
        env: { ...process.env, XDG_CONFIG_HOME: tmpDir },
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

      const lockPath = path.join(getConfigDir(), ".config.json.lock");
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(lockPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.existsSync(lockPath)).toBe(true);

      // Stand in for the rival that judged the stalled hold stale and took the
      // name for itself.
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, nonce: "successor", at: Date.now() }),
      );

      fs.writeFileSync(configPath, "{}\n"); // unpark the child's read
      expect(await exited).toBe(0);

      // Releasing by path alone would delete the successor's lock and let a
      // third process merge alongside it — the race this lock exists to close.
      expect(fs.existsSync(lockPath)).toBe(true);
      const holder = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { nonce?: string };
      expect(holder.nonce).toBe("successor");
    },
    60_000,
  );

  it("still merges rather than replacing, under the lock", () => {
    mergeConfigFile({ apiKey: "hbr_first" });
    const merged = mergeConfigFile({ adminKey: "hbradm_second" });
    expect(merged.apiKey).toBe("hbr_first");
    expect(merged.adminKey).toBe("hbradm_second");
    expect(fs.statSync(getConfigFilePath()).mode & 0o777).toBe(0o600);
  });
});
