import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicAsync } from "../src/atomicWrite.js";

// `vi.spyOn(fs, "linkSync")` fails under ESM ("module namespace is not
// configurable"), so the F5/R5 tests below instead mock the whole `node:fs`
// module, wrapping ONLY `linkSync` and `rmSync` in `vi.fn`s whose default
// implementation is the real one — every other fs call in this file
// (including atomicWrite.ts's own openSync/writeFileSync/renameSync/etc.) is
// untouched. `mockImplementationOnce` in each test then overrides exactly one
// call before reverting to the real function on its own.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    rmSync: vi.fn(actual.rmSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

// The async writer needs the same seam for the same reason: its exclusive
// publish is `fsp.link`, and no filesystem a test can create here refuses one.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-atomic-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

/** An fs error shaped like the one Windows raises for a locked rename. */
const errno = (code: string) =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: "rename" });

/** Run `fn` with `process.platform` reporting `platform`. */
const onPlatform = (platform: NodeJS.Platform, fn: () => void) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
};

describe("writeFileAtomic on a Windows rename failure", () => {
  let actual: typeof import("node:fs");

  // Back to the real functions (and zeroed call counts) around every test, so a
  // persistent mockImplementation cannot leak into the describes that follow.
  const restoreFs = () => {
    vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
    vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  };

  beforeAll(async () => {
    actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  });
  beforeEach(() => restoreFs());
  afterEach(() => restoreFs());

  it("retries a transient EPERM and then publishes atomically", () => {
    const target = path.join(dir, "config.json");
    fs.writeFileSync(target, "old");
    vi.mocked(fs.renameSync)
      .mockImplementationOnce(() => {
        throw errno("EPERM");
      })
      .mockImplementationOnce(() => {
        throw errno("EBUSY");
      });

    onPlatform("win32", () => writeFileAtomic(target, "new", { mode: 0o600 }));

    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("gives up after the retries, leaving the original intact and never writing to it directly", () => {
    // No write-in-place fallback: writing through the destination name would
    // follow a link planted there, keep the file's old mode, and truncate it
    // before writing, so its own failure would destroy the config.
    const target = path.join(dir, "config.json");
    fs.writeFileSync(target, "old");
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw errno("EPERM");
    });

    onPlatform("win32", () => {
      expect(() => writeFileAtomic(target, "new", { mode: 0o600 })).toThrow(/EPERM/);
    });

    // One attempt plus one per backoff step.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(8);
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(([file]) => file === target)).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("retries the exclusive fallback's rename too, so a minted credential is not lost", () => {
    // A filesystem without hard links sends an exclusive write to rename();
    // a transient lock there must not delete the only copy of the secret.
    const target = path.join(dir, "minted.json");
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno("EPERM");
    });

    onPlatform("win32", () => writeFileAtomic(target, "secret", { mode: 0o600, exclusive: true }));

    expect(fs.readFileSync(target, "utf-8")).toBe("secret");
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(dir)).toEqual(["minted.json"]);
  });

  it("does not retry the exclusive fallback's rename off Windows", () => {
    const target = path.join(dir, "minted.json");
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno("EPERM");
    });

    onPlatform("linux", () => {
      expect(() => writeFileAtomic(target, "secret", { mode: 0o600, exclusive: true })).toThrow(
        /EPERM/,
      );
    });

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not retry off Windows, where EPERM is a real permission error", () => {
    const target = path.join(dir, "config.json");
    fs.writeFileSync(target, "old");
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw errno("EPERM");
    });

    onPlatform("linux", () => {
      expect(() => writeFileAtomic(target, "new", { mode: 0o600 })).toThrow(/EPERM/);
    });

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target, "utf-8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("does not retry an error that is not a lock", () => {
    const target = path.join(dir, "config.json");
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw errno("ENOSPC");
    });

    onPlatform("win32", () => {
      expect(() => writeFileAtomic(target, "new", { mode: 0o600 })).toThrow(/ENOSPC/);
    });

    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1);
  });
});

describe("writeFileAtomic", () => {
  it("creates a new file with the requested mode", () => {
    const target = path.join(dir, "new.json");

    writeFileAtomic(target, "hello", { mode: 0o600 });

    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(modeOf(target)).toBe(0o600);
  });

  it("replaces an existing file's contents", () => {
    const target = path.join(dir, "existing.json");
    fs.writeFileSync(target, "old");

    writeFileAtomic(target, "new", { mode: 0o600 });

    expect(fs.readFileSync(target, "utf-8")).toBe("new");
  });

  it("preserves the mode of a file it did not create", () => {
    // A third-party client's config is not ours to re-permission: rename replaces
    // the inode, so without this the write would silently tighten (or loosen) the
    // mode the owning application chose.
    const target = path.join(dir, "foreign.json");
    fs.writeFileSync(target, "old", { mode: 0o644 });
    fs.chmodSync(target, 0o644);

    writeFileAtomic(target, "new", { mode: 0o600, preserveExistingMode: true });

    expect(modeOf(target)).toBe(0o644);
  });

  it("tightens an existing loose mode by default", () => {
    // The credential file relies on this: a legacy world-readable config must come
    // back as 0600 on the next write, not keep the mode it was found with.
    const target = path.join(dir, "ours.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o644);

    writeFileAtomic(target, "new", { mode: 0o600 });

    expect(modeOf(target)).toBe(0o600);
  });

  it("writes binary content byte-for-byte", () => {
    const target = path.join(dir, "blob.bin");
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    writeFileAtomic(target, bytes, { mode: 0o600 });

    expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes);
  });

  it("leaves no temp file behind on success", () => {
    writeFileAtomic(path.join(dir, "clean.json"), "x", { mode: 0o600 });

    expect(fs.readdirSync(dir)).toEqual(["clean.json"]);
  });

  it("leaves the original intact and no temp behind when the write fails", () => {
    const target = path.join(dir, "keep.json");
    fs.writeFileSync(target, "original");

    // A directory where the content should be forces a failure mid-write.
    expect(() =>
      writeFileAtomic(target, { bad: true } as unknown as string, { mode: 0o600 }),
    ).toThrow();

    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.json"]);
  });

  it("creates the parent directory when asked", () => {
    const target = path.join(dir, "nested", "deep", "file.json");

    writeFileAtomic(target, "x", { mode: 0o600, mkdirMode: 0o700 });

    expect(fs.readFileSync(target, "utf-8")).toBe("x");
    expect(modeOf(path.dirname(target))).toBe(0o700);
  });

  it("writes the temp file in the destination directory, not the system tmpdir", () => {
    // A cross-device rename is not atomic (and fails outright on many systems),
    // so the temp file has to be a sibling of the target.
    const target = path.join(dir, "sibling.json");
    let tmpPath = "";
    let observed: string[] = [];

    writeFileAtomic(target, "x", {
      mode: 0o600,
      onTempCreated: (p) => {
        tmpPath = p;
        observed = fs.readdirSync(dir);
      },
    });

    expect(path.dirname(tmpPath)).toBe(dir);
    expect(observed).toContain(path.basename(tmpPath));
  });

  describe("precondition", () => {
    it("runs after the temp is written and before publishing", () => {
      const target = path.join(dir, "pre.json");
      fs.writeFileSync(target, "old");
      const order: string[] = [];
      let seenAtCheck = "";

      writeFileAtomic(target, "new", {
        mode: 0o600,
        onTempCreated: () => order.push("temp"),
        precondition: () => {
          order.push("precondition");
          seenAtCheck = fs.readFileSync(target, "utf-8");
        },
      });

      expect(order).toEqual(["temp", "precondition"]);
      expect(seenAtCheck).toBe("old"); // not yet published when it ran
      expect(fs.readFileSync(target, "utf-8")).toBe("new");
    });

    // On Windows a locked destination is retried for up to ~1.3s; the app holding
    // the lock is often the one saving the file. A check made only before the
    // first attempt would let a later retry publish over that save.
    it("runs again before each rename retry on a Windows lock, and can veto it", () => {
      const target = path.join(dir, "pre.json");
      fs.writeFileSync(target, "old");
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw errno("EPERM");
      });
      let checks = 0;
      const veto = new Error("changed while locked");

      onPlatform("win32", () => {
        expect(() =>
          writeFileAtomic(target, "new", {
            mode: 0o600,
            precondition: () => {
              if (++checks === 2) throw veto;
            },
          }),
        ).toThrow(veto);
      });

      expect(checks).toBe(2);
      expect(fs.readFileSync(target, "utf-8")).toBe("old");
      expect(fs.readdirSync(dir)).toEqual(["pre.json"]);
    });

    it("rethrows a veto from a retry's re-check even when removing the temp fails", () => {
      const target = path.join(dir, "pre.json");
      fs.writeFileSync(target, "old");
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw errno("EPERM");
      });
      vi.mocked(fs.rmSync).mockImplementationOnce(() => {
        throw errno("EACCES");
      });
      let checks = 0;
      const veto = new Error("changed while locked");

      onPlatform("win32", () => {
        expect(() =>
          writeFileAtomic(target, "new", {
            mode: 0o600,
            precondition: () => {
              if (++checks === 2) throw veto;
            },
          }),
        ).toThrow(veto);
      });
      expect(fs.readFileSync(target, "utf-8")).toBe("old");
    });

    it("rethrows its own error even when removing the temp fails", () => {
      const target = path.join(dir, "pre.json");
      const veto = new Error("changed underneath");
      vi.mocked(fs.rmSync).mockImplementationOnce(() => {
        throw errno("EACCES");
      });

      expect(() =>
        writeFileAtomic(target, "new", {
          mode: 0o600,
          precondition: () => {
            throw veto;
          },
        }),
      ).toThrow(veto);
    });

    it("publishes nothing and removes the temp when it throws, rethrowing the same error", () => {
      const target = path.join(dir, "pre.json");
      fs.writeFileSync(target, "old");
      const veto = new Error("changed underneath");

      expect(() =>
        writeFileAtomic(target, "new", {
          mode: 0o600,
          precondition: () => {
            throw veto;
          },
        }),
      ).toThrow(veto);

      expect(fs.readFileSync(target, "utf-8")).toBe("old");
      expect(fs.readdirSync(dir)).toEqual(["pre.json"]);
    });
  });

  describe("exclusive", () => {
    it("vetoes the first fallback rename when state changes during an unsupported link", () => {
      const target = path.join(dir, "exclusive.json");
      const revisionFile = path.join(dir, "revision.txt");
      fs.writeFileSync(revisionFile, "original");
      const veto = new Error("revision changed during link");
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        fs.writeFileSync(revisionFile, "newer");
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      });

      expect(() =>
        writeFileAtomic(target, "replacement", {
          mode: 0o600,
          exclusive: true,
          precondition: () => {
            if (fs.readFileSync(revisionFile, "utf8") !== "original") throw veto;
          },
        }),
      ).toThrow(veto);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readFileSync(revisionFile, "utf8")).toBe("newer");
      expect(fs.readdirSync(dir)).toEqual(["revision.txt"]);
    });

    it("publishes through the fallback when the refreshed precondition still permits it", () => {
      const target = path.join(dir, "exclusive.json");
      let linkAttempted = false;
      let checkedAfterLink = false;
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        linkAttempted = true;
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      });

      writeFileAtomic(target, "replacement", {
        mode: 0o600,
        exclusive: true,
        precondition: () => {
          if (linkAttempted) checkedAfterLink = true;
        },
      });
      expect(checkedAfterLink).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("replacement");
      expect(fs.readdirSync(dir)).toEqual(["exclusive.json"]);
    });

    it("creates a new file via link() and leaves no temp behind", () => {
      const target = path.join(dir, "exclusive.json");

      writeFileAtomic(target, "secret", { mode: 0o600, exclusive: true });

      expect(fs.readFileSync(target, "utf-8")).toBe("secret");
      expect(modeOf(target)).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(["exclusive.json"]);
    });

    it("throws EEXIST over an existing file, leaving the original intact and no temp behind", () => {
      const target = path.join(dir, "exclusive.json");
      fs.writeFileSync(target, "original", { mode: 0o600 });

      expect(() =>
        writeFileAtomic(target, "attacker-controlled", { mode: 0o600, exclusive: true }),
      ).toThrow(/EEXIST/);

      expect(fs.readFileSync(target, "utf-8")).toBe("original");
      expect(fs.readdirSync(dir)).toEqual(["exclusive.json"]); // no temp left behind
    });
  });

  describe("exclusive — hard-link-unsupported fallback (F5)", () => {
    it("falls back to rename() and still succeeds when link() reports ENOTSUP", () => {
      const target = path.join(dir, "notsup.json");
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        const err = new Error(
          "ENOTSUP: operation not supported on socket",
        ) as NodeJS.ErrnoException;
        err.code = "ENOTSUP";
        throw err;
      });

      writeFileAtomic(target, "secret", { mode: 0o600, exclusive: true });

      expect(fs.readFileSync(target, "utf-8")).toBe("secret");
      expect(fs.readdirSync(dir)).toEqual(["notsup.json"]); // no temp left behind
    });

    // The async twin of this is at "refuses a dangling symlink when link() is
    // unsupported". `existsSync` follows the link and answers "free", so the
    // two writers used to disagree about the same destination.
    it("refuses a dangling symlink when link() is unsupported", () => {
      const target = path.join(dir, "notsup-dangling.json");
      fs.symlinkSync(path.join(dir, "no-such-target.json"), target);
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        const err = new Error("ENOTSUP: operation not supported") as NodeJS.ErrnoException;
        err.code = "ENOTSUP";
        throw err;
      });

      let thrown: NodeJS.ErrnoException | undefined;
      try {
        writeFileAtomic(target, "payload", { mode: 0o600, exclusive: true });
      } catch (err) {
        thrown = err as NodeJS.ErrnoException;
      }

      expect(thrown?.code).toBe("EEXIST");
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("still refuses to overwrite an existing file when link() is unsupported, with an EEXIST-shaped error", () => {
      const target = path.join(dir, "notsup-existing.json");
      fs.writeFileSync(target, "original", { mode: 0o600 });
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      let thrown: NodeJS.ErrnoException | undefined;
      try {
        writeFileAtomic(target, "attacker-controlled", { mode: 0o600, exclusive: true });
      } catch (err) {
        thrown = err as NodeJS.ErrnoException;
      }

      // Shaped exactly like a real link()-EEXIST — mintedCredentialStore.ts's
      // `persistMintedCredential` discriminates on `syscall === "link"` (F4)
      // to tell "destination already exists" apart from "the temp collided",
      // so the fallback has to preserve that discriminant too.
      expect(thrown?.code).toBe("EEXIST");
      expect(thrown?.syscall).toBe("link");
      expect(fs.readFileSync(target, "utf-8")).toBe("original");
      expect(fs.readdirSync(dir)).toEqual(["notsup-existing.json"]); // no temp left behind
    });

    /**
     * L2 (round-3 review) — the fallback used to match an ENUMERATED allowlist
     * (`EPERM`/`ENOTSUP`/`EXDEV`), which missed macOS entirely: Linux's
     * `link(2)` reports `ENOTSUP` for a filesystem with no hard-link support,
     * but macOS reports `EOPNOTSUPP` for the identical condition — a
     * DIFFERENT errno (-102, vs `ENOTSUP`'s -45) that Node does not translate
     * to a named constant, so `err.code` comes back `"UNKNOWN"` (verified on
     * this machine: `util.getSystemErrorName(-102)` -> `"Unknown system error
     * -102"`, platform `darwin`). The match is now EXCLUSION-based (anything
     * that isn't `EEXIST` falls back) so this class of miss cannot recur.
     */
    it('falls back to rename() for macOS\'s EOPNOTSUPP, surfaced by Node as code "UNKNOWN" — the case that motivated excluding rather than enumerating', () => {
      const target = path.join(dir, "macos-eopnotsupp.json");
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        const err = new Error("UNKNOWN: unknown error") as NodeJS.ErrnoException;
        err.code = "UNKNOWN";
        throw err;
      });

      writeFileAtomic(target, "secret", { mode: 0o600, exclusive: true });

      expect(fs.readFileSync(target, "utf-8")).toBe("secret");
      expect(fs.readdirSync(dir)).toEqual(["macos-eopnotsupp.json"]); // no temp left behind
    });

    it("falls back to rename() and succeeds for an arbitrary non-EEXIST code with no allowlist entry at all (e.g. EIO)", () => {
      // Proves the match is exclusion-based, not an allowlist that could miss
      // the NEXT untested platform/errno the way it missed macOS: any code
      // other than EEXIST falls back, full stop.
      const target = path.join(dir, "arbitrary-error.json");
      vi.mocked(fs.linkSync).mockImplementationOnce(() => {
        const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      });

      writeFileAtomic(target, "x", { mode: 0o600, exclusive: true });

      expect(fs.readFileSync(target, "utf-8")).toBe("x");
      expect(fs.readdirSync(dir)).toEqual(["arbitrary-error.json"]); // no temp left behind
    });
  });

  describe("exclusive — cleanup after a successful link() is best-effort (R5)", () => {
    it("still reports success when the post-link temp cleanup fails, with the file correctly published", () => {
      // link() has ALREADY published the file at this point — a failure to
      // remove the now-redundant temp sibling must not be reported as a write
      // failure. Getting this wrong is the worst-possible-direction bug: a
      // caller (persistMintedCredential -> KeyAdminService) would tell an
      // operator the one-time secrets are unrecoverable while they are
      // sitting, fully written, at exactly the path being complained about.
      const target = path.join(dir, "cleanup-fails.json");
      // Captured from the seam rather than recomputed: since M6 the temp name
      // carries a per-attempt random nonce, so only the writer knows it.
      let tmpPath: string | undefined;
      vi.mocked(fs.rmSync).mockImplementationOnce(() => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      expect(() =>
        writeFileAtomic(target, "secret", {
          mode: 0o600,
          exclusive: true,
          onTempCreated: (p) => {
            tmpPath = p;
          },
        }),
      ).not.toThrow();

      // The destination is correctly published with the real content...
      expect(fs.readFileSync(target, "utf-8")).toBe("secret");
      // ...even though the orphaned temp sibling is left behind (the
      // best-effort cleanup itself is what failed) — a cosmetic leftover,
      // not a correctness problem.
      expect(tmpPath).toBeDefined();
      expect(fs.readdirSync(dir).sort()).toEqual(
        [target, tmpPath as string].map((p) => path.basename(p)).sort(),
      );
    });
  });
});

describe("writeFileAtomicAsync", () => {
  it("creates a new file with the requested mode and byte-exact content", async () => {
    const target = path.join(dir, "async.bin");
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    await writeFileAtomicAsync(target, bytes, { mode: 0o600 });

    expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes);
    expect(modeOf(target)).toBe(0o600);
  });

  it("does not publish the file when the signal is already aborted, and leaves no temp", async () => {
    // The F10 guarantee for a cancelled download: the destination is untouched and
    // nothing half-written is left lying around.
    const target = path.join(dir, "cancelled.bin");
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeFileAtomicAsync(target, "secret plaintext", { mode: 0o600, signal: controller.signal }),
    ).rejects.toThrow();

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]); // no destination AND no temp sibling
  });

  it("does not overwrite an existing file when aborted before the rename", async () => {
    const target = path.join(dir, "keep.bin");
    fs.writeFileSync(target, "original");
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeFileAtomicAsync(target, "replacement", { mode: 0o600, signal: controller.signal }),
    ).rejects.toThrow();

    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.bin"]); // no temp left behind
  });

  it("leaves the original intact and no temp behind when the write fails", async () => {
    const target = path.join(dir, "keep.json");
    fs.writeFileSync(target, "original");

    await expect(
      writeFileAtomicAsync(target, { bad: true } as unknown as string, { mode: 0o600 }),
    ).rejects.toThrow();

    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.json"]);
  });

  // COMG-790: the download path writes to a destination the agent chose, so an
  // existing file there must survive untouched unless the caller opted in.
  it("exclusive refuses an existing destination and leaves its bytes and mode alone", async () => {
    const target = path.join(dir, "exclusive-existing.bin");
    fs.writeFileSync(target, "original", { mode: 0o644 });
    fs.chmodSync(target, 0o644);

    await expect(
      writeFileAtomicAsync(target, "replacement", { mode: 0o600, exclusive: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    // No temp sibling left behind by the refusal.
    expect(fs.readdirSync(dir)).toEqual(["exclusive-existing.bin"]);
  });

  it("exclusive writes the file when the destination is free", async () => {
    const target = path.join(dir, "exclusive-new.bin");

    await writeFileAtomicAsync(target, "fresh", { mode: 0o600, exclusive: true });

    expect(fs.readFileSync(target, "utf-8")).toBe("fresh");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["exclusive-new.bin"]);
  });

  it("exclusive publishes nothing when the signal aborts before the write is published", async () => {
    const target = path.join(dir, "exclusive-aborted.bin");
    const controller = new AbortController();

    await expect(
      writeFileAtomicAsync(target, "fresh", {
        mode: 0o600,
        exclusive: true,
        signal: controller.signal,
        onTempCreated: () => controller.abort(),
      }),
    ).rejects.toThrow(/abort/i);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // Same fallback the sync writer has: a filesystem that cannot hard-link must
  // not lose the refusal, and must not lose the write either.
  it("falls back to rename() when link() is unsupported, and still publishes", async () => {
    const target = path.join(dir, "async-notsup.bin");
    vi.mocked(fsp.link).mockImplementationOnce(() => {
      const err = new Error("ENOTSUP: operation not supported") as NodeJS.ErrnoException;
      err.code = "ENOTSUP";
      return Promise.reject(err);
    });

    await writeFileAtomicAsync(target, "payload", { mode: 0o600, exclusive: true });

    expect(fs.readFileSync(target, "utf-8")).toBe("payload");
    expect(fs.readdirSync(dir)).toEqual(["async-notsup.bin"]);
  });

  // `link()` fails EEXIST when the destination IS a symlink, dangling or not,
  // so the fallback's own existence check has to look at the link rather than
  // follow it. Following it answers "free" and renames over the link.
  it("refuses a dangling symlink when link() is unsupported", async () => {
    const target = path.join(dir, "async-dangling.bin");
    fs.symlinkSync(path.join(dir, "no-such-target.bin"), target);
    vi.mocked(fsp.link).mockImplementationOnce(() => {
      const err = new Error("ENOTSUP: operation not supported") as NodeJS.ErrnoException;
      err.code = "ENOTSUP";
      return Promise.reject(err);
    });

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      await writeFileAtomicAsync(target, "payload", { mode: 0o600, exclusive: true });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    expect(thrown?.code).toBe("EEXIST");
    // Still a symlink, still dangling: nothing was published through or over it.
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("still refuses an existing file when link() is unsupported, with an EEXIST-shaped error", async () => {
    const target = path.join(dir, "async-notsup-existing.bin");
    fs.writeFileSync(target, "original", { mode: 0o600 });
    vi.mocked(fsp.link).mockImplementationOnce(() => {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      return Promise.reject(err);
    });

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      await writeFileAtomicAsync(target, "attacker-controlled", {
        mode: 0o600,
        exclusive: true,
      });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    // `syscall: "link"` is load-bearing downstream, so the fallback keeps it.
    expect(thrown?.code).toBe("EEXIST");
    expect(thrown?.syscall).toBe("link");
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["async-notsup-existing.bin"]);
  });

  // `preserveExistingMode` is what keeps a deliberate overwrite from resetting a
  // read-only file to the writer's own mode.
  it("keeps the existing file's mode when replacing it with preserveExistingMode", async () => {
    const target = path.join(dir, "preserve-mode.bin");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o444);

    await writeFileAtomicAsync(target, "new", { mode: 0o600, preserveExistingMode: true });

    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    expect(fs.statSync(target).mode & 0o777).toBe(0o444);
  });

  it("gives two overlapping attempts on the same destination distinct temp names, so aborting one leaves the other's write untouched (M6)", async () => {
    // Before M6, `atomicTempPath` was a pure function of destination + pid, so
    // two attempts on the same destination computed the IDENTICAL temp path.
    // Started concurrently (neither awaited before the other starts, exactly
    // like a retry racing an abandoned write), the second either failed
    // `open(…, "wx")` with EEXIST, or — if it won that race — had its temp
    // deleted out from under it by the first attempt's abort cleanup. A random
    // nonce per call makes every attempt's temp unique, so neither can happen.
    const target = path.join(dir, "shared.json");
    const observedTemps: string[] = [];
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const attemptA = writeFileAtomicAsync(target, "from A", {
      mode: 0o600,
      signal: controllerA.signal,
      onTempCreated: (tmpPath) => {
        observedTemps.push(tmpPath);
        // Abort this attempt only once its own temp exists on disk, so the
        // cleanup below has to run without disturbing attempt B's temp.
        controllerA.abort();
      },
    });

    const attemptB = writeFileAtomicAsync(target, "from B", {
      mode: 0o600,
      signal: controllerB.signal,
      onTempCreated: (tmpPath) => {
        observedTemps.push(tmpPath);
      },
    });

    await expect(attemptA).rejects.toThrow();
    await expect(attemptB).resolves.toBeUndefined();

    expect(observedTemps).toHaveLength(2);
    expect(observedTemps[0]).not.toBe(observedTemps[1]);

    expect(fs.readFileSync(target, "utf-8")).toBe("from B");
    expect(fs.readdirSync(dir)).toEqual(["shared.json"]);
  });
});

// Long-file-name coverage moved to tests/atomicWriteLongFileName.test.ts: it
// is the file the Windows CI job runs, unfiltered, and a `-t` selection into
// this file's tests exits 0 (everything skipped) if the filter ever stops
// matching — see that file's header comment.
