import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Redacted } from "effect";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, verifiedBucket } from "./verifiedBucket";
import { type RootsCapableServer, resolveDownloadDestWithinRoots } from "../src/pathSandbox";
import { toolRegistrationBlock } from "./toolSource";

/**
 * COMG-1039: `download_file` must refuse a dest whose final component is a
 * symlink, including when `overwrite: true` is set. Reporter case 2 (read-only
 * dest without the flag) is asserted here so this stacked PR does not edit
 * PR #67's overwrite suite.
 */

const ORIGINAL = Buffer.from("ORIGINAL-DO-NOT-CLOBBER\n");

function fakeServer(root: string): RootsCapableServer {
  return {
    getClientCapabilities: () => ({ roots: {} }),
    listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }),
  };
}

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: "",
  keyAdminAddress: "",
};

function makeDownloadLayer() {
  return ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, {
          downloadBucketFile: () => Effect.succeed(new Uint8Array(ORIGINAL)),
          // The download reads the record the binding is compared
          // against before it decrypts.
          getBucketFile: (_b: string, f: string) => Effect.succeed(boundFile(f)),
          // ...and the bucket, for the `creator` the expected group is derived from.
          getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
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
}

async function downloadViaHandler(root: string, destPath: string, overwrite = false) {
  const resolved = await resolveDownloadDestWithinRoots(
    fakeServer(root),
    destPath,
    "Destination",
    {},
    [],
  );
  return Effect.runPromise(
    ConsoleStorageService.pipe(
      Effect.flatMap((s) =>
        s.downloadFile(BucketId.make("b"), FileId.make("f"), resolved, overwrite),
      ),
      Effect.either,
      Effect.provide(makeDownloadLayer()),
    ),
  );
}

let dir: string;
let allowed: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "comg1039-dest-"));
  allowed = path.join(dir, "allowed");
  outside = path.join(dir, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), ORIGINAL);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("COMG-1039 download dest symlink", () => {
  it("refuses a dest symlink pointing outside the roots", async () => {
    const secret = path.join(outside, "secret.txt");
    const link = path.join(allowed, "link");
    fs.chmodSync(secret, 0o644);
    fs.symlinkSync(secret, link, "file");

    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), link, "Destination", {}, []),
    ).rejects.toThrow(/outside the/);

    expect(fs.readFileSync(secret)).toEqual(ORIGINAL);
    expect(fs.statSync(secret).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a dest symlink pointing inside the roots", async () => {
    const target = path.join(allowed, "target.txt");
    const link = path.join(allowed, "link");
    fs.writeFileSync(target, ORIGINAL, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, link, "file");

    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), link, "Destination", {}, []),
    ).rejects.toThrow(/Refusing to write through a symlink/);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target)).toEqual(ORIGINAL);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it("refuses a relative dest symlink under the first root", async () => {
    const target = path.join(allowed, "target.txt");
    const link = path.join(allowed, "link");
    fs.writeFileSync(target, ORIGINAL, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, link, "file");

    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), "link", "Destination", {}, []),
    ).rejects.toThrow(/Refusing to write through a symlink/);

    expect(fs.readFileSync(target)).toEqual(ORIGINAL);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it("refuses a directory dest including the allowed root itself", async () => {
    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), allowed, "Destination", {}, []),
    ).rejects.toThrow(/is a directory/);
    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), "", "Destination", {}, []),
    ).rejects.toThrow(/is a directory/);
    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), ".", "Destination", {}, []),
    ).rejects.toThrow(/is a directory/);
  });

  // The sibling arm to the directory check above. A directory trips
  // `isDirectory()` first, so `!isFile()` is only ever reached by a FIFO,
  // socket or device node — and without it such a dest is APPROVED: with
  // `overwrite: true` the atomic rename then replaces the special file the
  // user made with a regular one (measured: ~7ms, no error). Without the flag
  // PR #67's exclusive-create already refuses it, but with the misleading
  // "already exists" message.
  it("refuses a dest that exists but is not a regular file", async () => {
    const fifo = path.join(allowed, "pipe.fifo");
    execFileSync("mkfifo", [fifo]);

    await expect(
      resolveDownloadDestWithinRoots(fakeServer(allowed), fifo, "Destination", {}, []),
    ).rejects.toThrow(/is not a regular file/);

    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  });

  it("allows a missing dest under an in-root directory symlink at the real path", async () => {
    const real = path.join(allowed, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(allowed, "link-dir"), "dir");
    const out = await resolveDownloadDestWithinRoots(
      fakeServer(allowed),
      "link-dir/new.txt",
      "Destination",
      {},
      [],
    );
    expect(out).toBe(path.join(fs.realpathSync(real), "new.txt"));
    expect(fs.existsSync(out)).toBe(false);
  });

  it("allows a missing regular dest under the roots", async () => {
    const dest = path.join(allowed, "out.bin");
    const out = await resolveDownloadDestWithinRoots(
      fakeServer(allowed),
      dest,
      "Destination",
      {},
      [],
    );
    expect(out).toBe(path.join(fs.realpathSync(allowed), "out.bin"));
    expect(fs.existsSync(dest)).toBe(false);
  });

  // Minor A. The assertion below (`toBe(fs.realpathSync(dest))` on a dest in
  // os.tmpdir()) only discriminates `realCandidate` from `absPath` because
  // macOS's tmpdir happens to BE a symlink; under TMPDIR=/private/tmp — and on
  // CI, which is ubuntu-latest only — the two are equal and the mutant lives.
  // A fixture-created parent symlink separates them on every platform. Its
  // sibling above covers the ENOENT return; this one covers the final return,
  // which is the path an existing dest takes.
  it("returns the real path for an EXISTING dest under an in-root directory symlink", async () => {
    const real = path.join(allowed, "real-existing");
    fs.mkdirSync(real);
    const target = path.join(real, "under-link.txt");
    fs.writeFileSync(target, ORIGINAL, { mode: 0o644 });
    fs.symlinkSync(real, path.join(allowed, "link-dir-existing"), "dir");

    const out = await resolveDownloadDestWithinRoots(
      fakeServer(allowed),
      "link-dir-existing/under-link.txt",
      "Destination",
      {},
      [],
    );

    expect(out).toBe(path.join(fs.realpathSync(real), "under-link.txt"));
    expect(out).not.toContain("link-dir-existing");
  });

  it("allows an existing regular dest under the roots", async () => {
    const dest = path.join(allowed, "existing.txt");
    fs.writeFileSync(dest, ORIGINAL, { mode: 0o644 });
    fs.chmodSync(dest, 0o644);
    const out = await resolveDownloadDestWithinRoots(
      fakeServer(allowed),
      dest,
      "Destination",
      {},
      [],
    );
    expect(out).toBe(fs.realpathSync(dest));
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dest)).toEqual(ORIGINAL);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o644);
  });
});

describe("COMG-1039 reporter case 2 (read-only dest, no overwrite)", () => {
  it("refuses a 0o444 dest without overwrite and leaves bytes and mode", async () => {
    const dest = path.join(allowed, "readonly.txt");
    fs.writeFileSync(dest, ORIGINAL, { mode: 0o444 });
    fs.chmodSync(dest, 0o444);

    const result = await downloadViaHandler(allowed, dest);

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("overwrite: true");
    }
    expect(fs.readFileSync(dest)).toEqual(ORIGINAL);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o444);
  });
});

describe("download_file dest-symlink wiring (COMG-1039)", () => {
  const block = toolRegistrationBlock("download_file");

  it("resolves dest through resolveDownloadDestWithinRoots, not resolvePathWithinRoots", () => {
    expect(block).toMatch(/resolveDownloadDestWithinRoots/);
    expect(block).not.toMatch(/resolvePathWithinRoots/);
  });

  it("resolves the dest unconditionally, before overwrite is consulted", () => {
    expect(block).toMatch(
      /try:\s*\(\)\s*=>\s*resolveDownloadDestWithinRoots\(server\.server,\s*destPath,\s*"Destination"\)/,
    );
    expect(block).not.toMatch(/overwrite\s*\?\s*destPath/);
    expect(block).toMatch(/storage\.downloadFile\([\s\S]*resolvedPath,\s*overwrite \?\? false/);
  });

  it("keeps overwrite pass-through next to the dest-symlink resolver", () => {
    expect(block).toMatch(/overwrite \?\? false/);
  });

  it("tells the agent a dest symlink is refused even with overwrite", () => {
    expect(block).toMatch(/A destPath that is a symlink is refused/);
    expect(block).toMatch(/even with this flag/);
  });
});
