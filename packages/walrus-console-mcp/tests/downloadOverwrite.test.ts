import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, FIXTURE_OWNER, verifiedBucket } from "./verifiedBucket";

/**
 * COMG-790. `destPath` is chosen by the agent, so a download that
 * replaces whatever is already there turns a prompt injection into an arbitrary
 * file overwrite on the developer's machine. The sandbox bounds WHERE a download
 * can land; these cover what happens when something is already at that spot.
 */

// Only `open` is wrapped, so the writer's own temp create can be made to fail
// the way a temp-name collision would. Everything else stays real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const PAYLOAD = new Uint8Array([1, 2, 3]);

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: FIXTURE_OWNER,
  keyAdminAddress: "",
};

const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ConsoleApiClient, {
        getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
        downloadBucketFile: () => Effect.succeed(PAYLOAD),
        getBucketFile: (_b: string, f: string) => Effect.succeed(boundFile(f)),
      } as unknown as typeof ConsoleApiClient.Service),
      Layer.succeed(SealCryptoService, {
        decrypt: (ciphertext: Uint8Array) =>
          Effect.succeed({ plaintext: ciphertext, authenticatedName: null, bound: false }),
      } as unknown as typeof SealCryptoService.Service),
      Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
      Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps),
    ),
  ),
);

const download = (destPath: string, overwrite?: boolean) =>
  Effect.runPromise(
    ConsoleStorageService.pipe(
      Effect.flatMap((s) =>
        s.downloadFile(BucketId.make("bucket-1"), FileId.make("file-1"), destPath, overwrite),
      ),
      Effect.either,
      Effect.provide(layer),
    ),
  );

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "download-overwrite-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o777;

describe("download_file overwrite policy", () => {
  it("refuses a destination that already holds a file, and says how to proceed", async () => {
    const dest = path.join(tmpDir, "notes.txt");
    await fs.writeFile(dest, "user data", { mode: 0o644 });
    await fs.chmod(dest, 0o644);

    const result = await download(dest);

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      // Names the destination and the way out. The raw errno message names the
      // temp file instead, which tells the caller nothing it can act on.
      expect(result.left.message).toContain(dest);
      expect(result.left.message).toContain("overwrite: true");
    }
    // The point of the ticket: the bytes and the mode of the user's file survive.
    expect(await fs.readFile(dest, "utf-8")).toBe("user data");
    expect(await modeOf(dest)).toBe(0o644);
    expect(await fs.readdir(tmpDir)).toEqual(["notes.txt"]);
  });

  // The temp file is opened `wx`, so it can raise EEXIST too. That one means
  // nothing was written and the destination is untouched, so advising
  // `overwrite: true` would send the caller after a problem they do not have.
  it("does not advise the flag when the EEXIST came from the temp file", async () => {
    const dest = path.join(tmpDir, "temp-collision.bin");
    const fsp = await import("node:fs/promises");
    vi.mocked(fsp.open).mockImplementationOnce(() => {
      const err = new Error("EEXIST: file already exists, open") as NodeJS.ErrnoException;
      err.code = "EEXIST";
      err.syscall = "open";
      return Promise.reject(err);
    });

    const result = await download(dest);

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).not.toContain("overwrite: true");
    }
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("writes when the destination is free, with the private mode", async () => {
    const dest = path.join(tmpDir, "fresh.bin");

    const result = await download(dest);

    expect(result._tag).toBe("Right");
    expect(new Uint8Array(await fs.readFile(dest))).toEqual(PAYLOAD);
    // Plaintext that was worth Seal-encrypting at rest must not land readable
    // by everyone under a loose umask.
    expect(await modeOf(dest)).toBe(0o600);
    expect(await fs.readdir(tmpDir)).toEqual(["fresh.bin"]);
  });

  // An opt-in replacement is not permission to re-permission the file: `rename`
  // swaps the inode, so the old mode has to be carried over deliberately. It is
  // carried in one direction only, because the content being published is
  // decrypted plaintext and the file it lands on may be readable by anyone.
  it.each([
    ["a read-only file keeps its restriction", 0o444, 0o400],
    ["an owner-only file is untouched", 0o600, 0o600],
    ["a world-readable file is tightened, not adopted", 0o644, 0o600],
    ["a group-writable file is tightened too", 0o666, 0o600],
  ])("replaces the file when the caller opts in: %s", async (_label, before, after) => {
    const dest = path.join(tmpDir, "existing.bin");
    await fs.writeFile(dest, "old");
    await fs.chmod(dest, before);

    const result = await download(dest, true);

    expect(result._tag).toBe("Right");
    expect(new Uint8Array(await fs.readFile(dest))).toEqual(PAYLOAD);
    expect(await modeOf(dest)).toBe(after);
    expect(await fs.readdir(tmpDir)).toEqual(["existing.bin"]);
  });

  it("writes at the private mode when the caller opts in but nothing is there", async () => {
    const dest = path.join(tmpDir, "absent.bin");

    const result = await download(dest, true);

    expect(result._tag).toBe("Right");
    expect(await modeOf(dest)).toBe(0o600);
  });

  // A directory is refused whether or not the caller opted in, so the message
  // must not send them round the loop with `overwrite: true`, which fails
  // EISDIR on the rename either way.
  it.each([
    ["without the flag", undefined],
    ["with the flag", true],
  ])(
    "refuses a directory at the destination %s, without advising the flag",
    async (_label, overwrite) => {
      const dest = path.join(tmpDir, "a-directory");
      await fs.mkdir(dest);

      const result = await download(dest, overwrite);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("is a directory");
        expect(result.left.message).not.toContain("overwrite: true");
      }
      expect((await fs.stat(dest)).isDirectory()).toBe(true);
      expect(await fs.readdir(tmpDir)).toEqual(["a-directory"]);
    },
  );
});
