import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigDir } from "../src/configFile.js";
import {
  getAnchorsFilePath,
  MAX_ANCHORS_PER_SPACE,
  readAnchors,
  recordAnchor,
} from "../src/console/anchorStore.js";

const CREATOR = `0x${"c".repeat(64)}`;
const entry = (
  over: Partial<{ groupId: string; bucketId: string; creator: string; recordedAt: string }> = {},
) => ({
  groupId: "group_1",
  bucketId: "bucket_1",
  creator: CREATOR,
  recordedAt: "2026-08-21T00:00:00.000Z",
  ...over,
});

// Same temp-XDG_CONFIG_HOME + real-filesystem pattern as tests/configFile.test.ts.
let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-anchor-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `anchors.json` verbatim, for shapes `recordAnchor` cannot produce. */
function writeRaw(data: unknown): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "anchors.json"), JSON.stringify(data), "utf-8");
}

describe("readAnchors — missing file", () => {
  it("returns [] when anchors.json does not exist (ENOENT, silent)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readAnchors("space_1")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("round-trip: recordAnchor then readAnchors", () => {
  it("writes to anchors.json beside config.json and reads it back", () => {
    recordAnchor("space_1", entry());

    const filePath = getAnchorsFilePath();
    expect(filePath).toBe(path.join(getConfigDir(), "anchors.json"));
    expect(fs.existsSync(filePath)).toBe(true);

    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(readAnchors("space_1")).toEqual([entry()]);
  });

  it("keeps anchors for other spaces untouched", () => {
    recordAnchor("space_1", entry());
    recordAnchor(
      "space_2",
      entry({
        groupId: "group_2",
        bucketId: "bucket_2",
        recordedAt: "2026-08-21T00:01:00.000Z",
      }),
    );

    expect(readAnchors("space_1")).toEqual([entry()]);
    expect(readAnchors("space_2")).toEqual([
      entry({
        groupId: "group_2",
        bucketId: "bucket_2",
        recordedAt: "2026-08-21T00:01:00.000Z",
      }),
    ]);
  });
});

describe("recordAnchor — anchors ACCUMULATE, newest first", () => {
  it("keeps the earlier entry for the same space instead of replacing it", () => {
    // Most-recent-wins was the ratchet: an identity-only create would throw away
    // the one anchor that carried evidence, and the next create had nothing to
    // verify a roster against. Every entry here is a group this client created
    // AND validated, so none of them stops being evidence.
    recordAnchor("space_1", entry({ groupId: "group_old", bucketId: "bucket_old" }));
    recordAnchor(
      "space_1",
      entry({
        groupId: "group_new",
        bucketId: "bucket_new",
        recordedAt: "2026-08-21T01:00:00.000Z",
      }),
    );

    expect(readAnchors("space_1")).toEqual([
      entry({
        groupId: "group_new",
        bucketId: "bucket_new",
        recordedAt: "2026-08-21T01:00:00.000Z",
      }),
      entry({ groupId: "group_old", bucketId: "bucket_old" }),
    ]);
  });

  it("moves a re-recorded group to the front rather than listing it twice", () => {
    // A duplicate would spend an anchor slot and a chain read on membership that
    // has already been counted.
    recordAnchor("space_1", entry({ groupId: "group_a", bucketId: "bucket_a" }));
    recordAnchor("space_1", entry({ groupId: "group_b", bucketId: "bucket_b" }));
    recordAnchor(
      "space_1",
      entry({ groupId: "group_a", bucketId: "bucket_a", recordedAt: "2026-08-22T00:00:00.000Z" }),
    );

    expect(readAnchors("space_1").map((a) => a.groupId)).toEqual(["group_a", "group_b"]);
    expect(readAnchors("space_1")[0]?.recordedAt).toBe("2026-08-22T00:00:00.000Z");
  });

  it("retains at most MAX_ANCHORS_PER_SPACE, dropping the oldest", () => {
    for (let i = 0; i <= MAX_ANCHORS_PER_SPACE; i++) {
      recordAnchor("space_1", entry({ groupId: `group_${i}`, bucketId: `bucket_${i}` }));
    }

    const groupIds = readAnchors("space_1").map((a) => a.groupId);
    expect(groupIds).toHaveLength(MAX_ANCHORS_PER_SPACE);
    expect(groupIds[0]).toBe(`group_${MAX_ANCHORS_PER_SPACE}`);
    // The very first one is what fell off the end.
    expect(groupIds).not.toContain("group_0");
  });
});

describe("readAnchors — unknown space", () => {
  it("returns [] for a space with no recorded anchor", () => {
    recordAnchor("space_1", entry());
    expect(readAnchors("space_unknown")).toEqual([]);
  });
});

describe("readAnchors — a space id that names an Object.prototype member", () => {
  // `spaceId` is a raw MCP tool argument, so `create_bucket({spaceId: "constructor"})`
  // reaches this lookup verbatim. On an object literal that resolves through
  // Object.prototype and hands back a FUNCTION, which the caller then treats as a
  // recorded anchor — the operator gets an opaque internal error instead of the
  // ordinary Console space-lookup failure.
  const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each(PROTOTYPE_KEYS)("returns [] for %s when no anchors file exists", (key) => {
    expect(readAnchors(key)).toEqual([]);
  });

  it.each(PROTOTYPE_KEYS)("returns [] for %s when other spaces are recorded", (key) => {
    recordAnchor("space_1", entry());
    expect(readAnchors(key)).toEqual([]);
  });

  it("still round-trips a space genuinely named `constructor`", () => {
    // The fix must not turn these keys into a deny list: a space id is opaque, so
    // one that happens to spell a prototype member is a real key like any other.
    recordAnchor("constructor", entry());
    expect(readAnchors("constructor")).toEqual([entry()]);
    expect(readAnchors("toString")).toEqual([]);
  });
});

describe("the pre-list file shape", () => {
  it("reads a single bare entry as a one-element list", () => {
    // Every file written before anchors became a list carries one entry per
    // space. That entry is a group this client created and validated — exactly
    // what an anchor is — so discarding it would throw away real evidence and
    // send the space back down the bootstrap path for nothing.
    writeRaw({ space_1: entry() });

    expect(readAnchors("space_1")).toEqual([entry()]);
  });

  it("upgrades the shape in place on the next record, keeping the old entry", () => {
    writeRaw({ space_1: entry({ groupId: "group_old", bucketId: "bucket_old" }) });

    recordAnchor("space_1", entry({ groupId: "group_new", bucketId: "bucket_new" }));

    expect(readAnchors("space_1").map((a) => a.groupId)).toEqual(["group_new", "group_old"]);
    const onDisk: unknown = JSON.parse(fs.readFileSync(getAnchorsFilePath(), "utf-8"));
    expect(Array.isArray((onDisk as Record<string, unknown>)["space_1"])).toBe(true);
  });
});

describe("corrupt or unreadable anchors file — degrades to empty with a warning", () => {
  it("warns to stderr and treats the file as empty when it is not valid JSON", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "anchors.json"), "not json", "utf-8");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readAnchors("space_1")).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatch(/anchor/i);
  });

  it("warns to stderr and treats the file as empty when it cannot be read (non-ENOENT)", () => {
    // Put a directory where the anchors file belongs so readFileSync fails with
    // EISDIR — a non-ENOENT read error on every platform, no chmod/root games.
    const dir = getConfigDir();
    fs.mkdirSync(path.join(dir, "anchors.json"), { recursive: true });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readAnchors("space_1")).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("drops an entry with a non-string field instead of throwing", () => {
    writeRaw({
      space_1: {
        groupId: "group_1",
        bucketId: 42,
        creator: CREATOR,
        recordedAt: entry().recordedAt,
      },
      space_2: entry({ groupId: "group_2", bucketId: "bucket_2" }),
    });

    expect(readAnchors("space_1")).toEqual([]);
    expect(readAnchors("space_2")).toEqual([entry({ groupId: "group_2", bucketId: "bucket_2" })]);
  });

  it("drops only the bad members of a list, keeping the rest of that space's anchors", () => {
    // One malformed entry must not cost a space every other anchor it has — the
    // same per-entry discipline `loadConfigFile` applies per field.
    writeRaw({
      space_1: [
        entry({ groupId: "group_good", bucketId: "bucket_good" }),
        { groupId: "group_bad", bucketId: 42, creator: CREATOR, recordedAt: "x" },
        "not an object",
        entry({ groupId: "group_also_good", bucketId: "bucket_also_good" }),
      ],
    });

    expect(readAnchors("space_1").map((a) => a.groupId)).toEqual(["group_good", "group_also_good"]);
  });

  it("drops a pre-derivation entry that has no creator", () => {
    writeRaw({
      space_1: { groupId: "group_1", bucketId: "bucket_1", recordedAt: entry().recordedAt },
    });

    expect(readAnchors("space_1")).toEqual([]);
  });

  it("caps an oversized list on READ, so a hand-edited file cannot unbound a create", () => {
    // Every retained anchor costs the next create an enumeration, so the bound
    // has to hold for files this client did not write.
    writeRaw({
      space_1: Array.from({ length: MAX_ANCHORS_PER_SPACE * 3 }, (_, i) =>
        entry({ groupId: `group_${i}`, bucketId: `bucket_${i}` }),
      ),
    });

    expect(readAnchors("space_1")).toHaveLength(MAX_ANCHORS_PER_SPACE);
  });

  it("recordAnchor on a corrupt file degrades to writing just the new entry (does not throw)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "anchors.json"), "not json", "utf-8");

    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => recordAnchor("space_1", entry())).not.toThrow();

    expect(readAnchors("space_1")).toEqual([entry()]);
  });
});
