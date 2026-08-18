/**
 * Smoke test for the download/upload path sandbox.
 *
 * Run:  npx tsx scripts/smoke-path-sandbox.mts
 *
 * Needs no credentials, no network, and touches nothing outside a fresh temp
 * directory it creates and removes. Safe to run anywhere, any time.
 *
 * The unit tests assert what `resolvePathWithinRoots` RETURNS. This asserts
 * something stricter and more useful: for every path the sandbox approves, it
 * performs the real write — the same plain `fs.writeFile` that
 * `ConsoleStorageService.downloadFile` performs, with no `mkdir -p` — and then
 * canonicalizes the file that actually appeared on disk to confirm the bytes
 * landed inside an allowed root.
 *
 * That distinction is the entire bug class this sandbox exists to prevent: a
 * check and a write can disagree about what a path means. A symlink is resolved
 * at open() time by the kernel, so "the string looked fine" proves nothing. Only
 * following the bytes does.
 *
 * Exit code is 0 when every case behaves as expected, 1 otherwise. Any approved
 * path whose bytes land outside the root is reported as ESCAPE and is a
 * release-blocking failure.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type RootsCapableServer, resolvePathWithinRoots, toRealPath } from "../src/pathSandbox.js";

type Expect = "approve" | "reject";

interface Case {
  readonly name: string;
  readonly path: string;
  readonly expect: Expect;
  readonly why: string;
}

const base = toRealPath(mkdtempSync(join(tmpdir(), "wcm-smoke-")));
const allowed = join(base, "allowed");
const outside = join(base, "outside");

/**
 * Recreate the fixture from scratch. Called before EVERY case, because the cases
 * mutate it: an approved case performs a real write, and that write can turn a
 * later case's dangling symlink into a live one, silently changing what is being
 * tested. (Observed for real — `dangling link mid-path` reported PASS against a
 * knowingly-broken implementation purely because an earlier case had created its
 * target.) Rebuilding costs microseconds and buys genuine independence.
 */
function build(): Case[] {
  rmSync(allowed, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(allowed);
  mkdirSync(outside);
  mkdirSync(join(allowed, "reports"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  writeFileSync(join(allowed, "target.txt"), "inside");

  symlinkSync(join(allowed, "target.txt"), join(allowed, "live-in"), "file");
  symlinkSync(join(outside, "secret.txt"), join(allowed, "live-out"), "file");
  symlinkSync(outside, join(allowed, "live-dir-out"), "dir");
  symlinkSync(join(outside, "planted.txt"), join(allowed, "dangling-out"), "file");
  symlinkSync(join(allowed, "reports", "q1.pdf"), join(allowed, "dangling-in"), "file");
  symlinkSync(join(allowed, "loop-b"), join(allowed, "loop-a"), "file");
  symlinkSync(join(allowed, "loop-a"), join(allowed, "loop-b"), "file");

  return [
    // --- ordinary use: no symlink anywhere on the path ---
    {
      name: "plain new file",
      path: join(allowed, "report.pdf"),
      expect: "approve",
      why: "the ordinary download destination",
    },
    {
      name: "plain new file in subdir",
      path: join(allowed, "reports", "q3.pdf"),
      expect: "approve",
      why: "ordinary, one level down",
    },
    {
      name: "existing file",
      path: join(allowed, "target.txt"),
      expect: "approve",
      why: "overwrite in place",
    },

    // --- live symlinks: still followed, then containment-checked ---
    {
      name: "live symlink, stays inside",
      path: join(allowed, "live-in"),
      expect: "approve",
      why: "must keep working — /tmp and /var are live links on macOS",
    },
    {
      name: "live symlink, escapes",
      path: join(allowed, "live-out"),
      expect: "reject",
      why: "resolves into outside/",
    },
    {
      name: "live dir symlink, escapes",
      path: join(allowed, "live-dir-out", "x.pdf"),
      expect: "reject",
      why: "symlinked parent redirects the write",
    },

    // --- broken symlinks: rejected outright, by design ---
    {
      name: "dangling link, escapes",
      path: join(allowed, "dangling-out"),
      expect: "reject",
      why: "THE BUG: used to be approved, then writeFile followed it out",
    },
    {
      name: "dangling link, points inside",
      path: join(allowed, "dangling-in"),
      expect: "reject",
      why: "deliberate trade — rejected even though it is harmless",
    },
    {
      name: "dangling link mid-path",
      path: join(allowed, "dangling-out", "sub", "f.pdf"),
      expect: "reject",
      why: "broken link as an intermediate directory",
    },
    {
      name: "symlink cycle",
      path: join(allowed, "loop-a"),
      expect: "reject",
      why: "no canonical form exists; must not hang",
    },

    // --- classic containment ---
    {
      name: "absolute path outside",
      path: join(outside, "secret.txt"),
      expect: "reject",
      why: "plainly outside every root",
    },
    {
      name: "parent traversal",
      path: join(allowed, "..", "outside", "secret.txt"),
      expect: "reject",
      why: "../ escape",
    },
    {
      name: "prefix-sibling root",
      path: `${allowed}-evil${sep}x.pdf`,
      expect: "reject",
      why: "shares a name prefix but is a different directory",
    },
  ];
}

const server: RootsCapableServer = {
  getClientCapabilities: () => ({ roots: {} }),
  listRoots: async () => ({ roots: [{ uri: pathToFileURL(allowed).href }] }),
};

const show = (p: string) => p.replace(base, "…");

async function run(): Promise<number> {
  const cases = build();
  let failures = 0;
  let escapes = 0;

  console.log(`\n  sandbox root: ${show(allowed)}`);
  console.log(`  off-limits:   ${show(outside)}\n`);
  console.log(`  ${"case".padEnd(30)}${"expected".padEnd(10)}actual`);
  console.log(`  ${"-".repeat(78)}`);

  for (const c of cases) {
    build(); // fresh fixture per case — see the note on build()
    let approved: string | undefined;
    let rejection: string | undefined;
    try {
      approved = await resolvePathWithinRoots(server, c.path, "Destination", {});
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }

    let actual: string;
    let ok: boolean;

    if (approved === undefined) {
      actual = "rejected";
      ok = c.expect === "reject";
    } else {
      // Approved — now follow the bytes. This is the part that matters.
      try {
        await writeFile(approved, "SMOKE");
        const landed = realpathSync(approved);
        const inside = landed === allowed || landed.startsWith(allowed + sep);
        if (inside) {
          actual = `approved, wrote ${show(landed)}`;
          ok = c.expect === "approve";
        } else {
          actual = `*** ESCAPE *** bytes landed at ${show(landed)}`;
          ok = false;
          escapes++;
        }
      } catch (error) {
        // Approved but unwritable (e.g. missing parent dir) — not a security
        // failure, but worth surfacing, since an approval that cannot be acted
        // on is a usability bug.
        actual = `approved, write failed (${(error as NodeJS.ErrnoException).code})`;
        ok = c.expect === "approve";
      }
    }

    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(30)}${c.expect.padEnd(10)}${actual}`);
    if (!ok)
      console.log(`        ↳ ${c.why}${rejection ? `\n        ↳ ${rejection.slice(0, 120)}` : ""}`);
  }

  // Fail-closed check: a client advertising no roots, with no env fallback, must
  // refuse everything rather than falling back to an unsandboxed path.
  const noRoots: RootsCapableServer = {
    getClientCapabilities: () => ({}),
    listRoots: async () => ({ roots: [] }),
  };
  let failedClosed = false;
  try {
    await resolvePathWithinRoots(noRoots, join(allowed, "x.pdf"), "Destination", {});
  } catch {
    failedClosed = true;
  }
  if (!failedClosed) failures++;
  console.log(
    `  ${failedClosed ? "PASS" : "FAIL"}  ${"no roots advertised".padEnd(30)}${"reject".padEnd(10)}${failedClosed ? "rejected (fails closed)" : "*** APPROVED WITHOUT A SANDBOX ***"}`,
  );

  console.log(`  ${"-".repeat(78)}`);
  if (escapes > 0) {
    console.log(
      `\n  ${escapes} ESCAPE(S) — approved bytes landed outside the root. Do not ship.\n`,
    );
  } else if (failures > 0) {
    console.log(
      `\n  ${failures} failure(s), but no escapes: the boundary held, behavior differs.\n`,
    );
  } else {
    console.log(
      `\n  All ${cases.length + 1} cases behaved as expected. No path escaped the sandbox.\n`,
    );
  }
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await run();
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
