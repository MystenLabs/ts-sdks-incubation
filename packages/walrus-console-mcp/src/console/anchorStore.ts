import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "../atomicWrite.js";
import { getConfigDir } from "../configFile.js";

/**
 * Local cache of "anchor groups" per space.
 *
 * A later task verifies which service accounts may receive grants on a NEW
 * bucket by reading the on-chain membership of an anchor group: a bucket
 * group this MCP itself created and validated on some earlier occasion. That
 * check is only useful if we remember which group was validated for which
 * space, so this module is that memory: `anchors.json`, keyed by space id,
 * living beside `config.json`.
 *
 * A LIST PER SPACE, NOT ONE ENTRY, and that is the whole point of the shape.
 * Remembering only the most recent validated bucket is a ratchet toward empty:
 * a create whose roster comes out identity-only (the bootstrap path, or a
 * moment when Console lists no other signer) produces a group with no evidence
 * in it, that group becomes the sole anchor, and the next create finds nothing
 * to verify against — so it drops a key it authored as chain-verified one
 * bucket earlier and produces another empty anchor. Confirmed live on testnet
 * 2026-08-23. Every entry here was created AND validated by this client, so
 * membership in any of them is equally good evidence; `rosterVerification`
 * unions them, which makes anchoring monotone (see `authorVerifiedRoster`).
 *
 * Deliberately the OPPOSITE failure policy from `configFile.ts`:
 *
 *  - `loadConfigFile` throws on a corrupt file because `mergeConfigFile` reads
 *    it and then writes the whole file back — a phantom `{}` there would
 *    silently wipe every saved credential.
 *  - An anchor carries no credential. It is pure, recoverable cache: the
 *    worst a lost or corrupt anchor does is send the next `create_bucket` down
 *    the slower bootstrap path (create a fresh group and validate it again),
 *    which is exactly what happens the very first time a space is ever seen.
 *    So a corrupt or unreadable anchors file WARNS to stderr and is treated as
 *    empty rather than failing the caller. A genuinely missing file (ENOENT)
 *    is the ordinary first-run case, not a problem, so it is silent.
 *
 * No locking, also unlike `mergeConfigFile`. The lock there exists because
 * losing a credential update is unacceptable; here, two writers racing and one
 * update getting lost just degrades that one space back to the bootstrap
 * path next time — safe to lose, not worth the complexity of a lock.
 */

const ANCHORS_FILENAME = "anchors.json";

/**
 * The most anchors retained for one space, newest first.
 *
 * Strictly GREATER than `MAX_ADMITTED_ANCHORS` (20), the cap the roster verifier
 * applies to the anchors it actually consults, and that ordering is the whole
 * reason for the number: the store cannot tell an anchor that carries evidence
 * from one that does not (that needs a chain read), so if retention were the
 * tighter bound it would be silently pre-applying a recency cap the verifier is
 * careful to apply only AFTER admission — the original bug wearing a bound.
 *
 * THE 12 SPARE SLOTS ARE HEADROOM FOR A RUN OF IDENTITY-ONLY CREATES, AND THAT
 * HEADROOM IS BOUNDED — READ THIS BEFORE TREATING THE RATCHET AS IMPOSSIBLE.
 * `recordAnchor` prepends and trims the TAIL of a newest-first list, so what ages
 * out is the OLDEST entry. Identity-only creates are the NEWEST, so they do not
 * age out first; they push the evidence-bearing anchor toward the tail, and 32
 * consecutive creates that author nobody evict the last one off the end. The
 * space then falls back to `no_admitted_anchor`, and no create there can verify a
 * roster until something grants again. The ratchet is IMPROBABLE at this size,
 * not structurally impossible, and no larger number makes it impossible.
 *
 * What makes that acceptable is the self-healing property, not the bound: any
 * create that authors a NON-EMPTY roster produces a group carrying those members
 * and records it at index 0, which resets the count to zero. So the eviction
 * needs 32 creates in a row that grant nobody, and a single ordinary create
 * anywhere in that run undoes it.
 *
 * Bounded rather than unbounded because retention costs chain reads, not just
 * disk: every retained entry that survives re-derivation is enumerated on the
 * next create (one object read plus its member pages) before admission can be
 * decided. 32 entries is ~8 KB per space and, worst case, 32 enumerations.
 */
export const MAX_ANCHORS_PER_SPACE = 32;

/** One validated anchor group recorded for a space. */
export interface AnchorEntry {
  readonly groupId: string;
  readonly bucketId: string;
  /**
   * The working-key address that created the bucket. Stored so a later create
   * can re-derive `groupId` from (registry, bucketId, creator) and refuse a
   * file that does not reproduce — a pre-derivation or tampered cache is
   * otherwise indistinguishable from a derived one. A rotated working key
   * still reads its old anchors because this field, not the current signer,
   * is the derivation input.
   */
  readonly creator: string;
  /**
   * The other two derivation inputs — `packageConfig.bucketRegistryId` and
   * `packageConfig.originalPackageId` — as they stood when `groupId` was
   * derived. Recorded so the reader can tell the two ways a re-derivation
   * fails apart, which need opposite handling:
   *
   *  - These DIFFER from the current config: the anchor is STALE, and the
   *    honest answer is the bootstrap path. This is scheduled, not
   *    hypothetical — `packageConfig.ts` says the staging entry "collapses back
   *    into TESTNET_PACKAGE_CONFIG and this entry is deleted" once the
   *    republish merges, and without these fields that day turns every stored
   *    anchor into a hard refusal until each operator deletes this file by
   *    hand. A host switch between two allowed Console deployments does the
   *    same to a re-used space id.
   *  - These MATCH and the id still does not reproduce: nothing benign explains
   *    that, so it keeps the hard refusal it was written for.
   *
   * OPTIONAL because entries written before this field existed do not carry it.
   * A missing (or half-written) pair reads as "derived under inputs unknown",
   * which takes the stale branch — degrading to bootstrap, never accusing an
   * older file of tampering. That absence is the whole compatibility story, so
   * the file needs no format version of its own.
   */
  readonly bucketRegistryId?: string;
  readonly originalPackageId?: string;
  readonly recordedAt: string;
}

/**
 * The in-memory map: space id → its anchors, MOST RECENT FIRST.
 *
 * Position, not `recordedAt`, is the recency order. `recordedAt` is a wall-clock
 * string this client wrote and a hand-edited or clock-skewed one would reorder
 * the list; the file's own order is something only `recordAnchor` writes.
 *
 * ON DISK a space's value is EITHER this array or a single bare entry object —
 * the shape every file written before anchors became a list carries. Those
 * entries are read as one-element lists rather than discarded: each is a group
 * this client created and validated, which is exactly what an anchor is, so
 * refusing them would throw away real evidence and send the space back down the
 * bootstrap path for no reason. That is also why the file still needs no format
 * version: the two shapes are distinguishable by `Array.isArray`, the old one
 * has a total reading, and `saveAnchors` writes only the new one.
 */
type AnchorsFileData = Record<string, AnchorEntry[]>;

/**
 * An anchors map with NO prototype.
 *
 * Every map this module hands out is indexed by a space id, and a space id is a
 * raw MCP tool argument: `create_bucket({spaceId: "constructor"})` walks
 * straight into `readAnchors`. On an object literal that lookup resolves through
 * `Object.prototype` and returns a FUNCTION, which the caller then treats as a
 * recorded anchor — an opaque internal failure in place of the ordinary Console
 * space-lookup error. Dropping the prototype is preferred over guarding the one
 * lookup because it makes every present and future read of these maps safe, and
 * it keeps genuine space ids that happen to spell `constructor` or `toString`
 * working like any other key.
 */
function emptyAnchors(): AnchorsFileData {
  return Object.create(null) as AnchorsFileData;
}

/** Full path to the anchors file — beside `config.json`, not recomputed. */
export function getAnchorsFilePath(): string {
  return path.join(getConfigDir(), ANCHORS_FILENAME);
}

/**
 * Load every recorded anchor, degrading to `{}` (with a stderr warning) on
 * anything but a genuinely missing file.
 *
 * Unlike `loadConfigFile`, there is no separate fail-stop variant: nothing
 * downstream of this ever merges-then-writes in a way a phantom empty object
 * could corrupt (see the module comment), so the safe behavior is the only
 * behavior.
 */
function loadAnchors(): AnchorsFileData {
  const filePath = getAnchorsFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyAnchors();
    console.error(
      `[console-mcp] The anchor cache at ${filePath} could not be read (${(err as Error).message}). ` +
        `Continuing without it — the next create_bucket for an affected space falls back to the bootstrap path.`,
    );
    return emptyAnchors();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[console-mcp] The anchor cache at ${filePath} could not be parsed as JSON (${(err as Error).message}). ` +
        `Continuing without it — the next create_bucket for an affected space falls back to the bootstrap path.`,
    );
    return emptyAnchors();
  }

  // `null`, arrays, and primitives are valid JSON but not the map we expect;
  // reading entries off them would throw or yield nonsense, so treat as empty.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return emptyAnchors();

  // Validate per-entry, the way `loadConfigFile` validates per-field: an entry
  // that fails validation is dropped rather than thrown on, so one bad/tampered
  // space entry does not cost every other space its cached anchors — nor cost
  // one space the rest of ITS list, which is why the list is filtered rather
  // than rejected whole.
  const result = emptyAnchors();
  for (const [spaceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    // The two on-disk shapes (see `AnchorsFileData`): a list, or one bare entry
    // from a file written before anchors became a list.
    const rawEntries: readonly unknown[] = Array.isArray(value) ? value : [value];
    const entries: AnchorEntry[] = [];
    for (const raw of rawEntries) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const groupId = entry["groupId"];
      const bucketId = entry["bucketId"];
      const creator = entry["creator"];
      const recordedAt = entry["recordedAt"];
      if (
        typeof groupId === "string" &&
        typeof bucketId === "string" &&
        typeof creator === "string" &&
        typeof recordedAt === "string"
      ) {
        // The derivation inputs travel as a PAIR or not at all: half a pair names
        // no derivation, and reading a stale half as a current one is how a
        // tamper check turns into a false accusation. Absent either way means
        // "unknown inputs", which the reader treats as stale rather than
        // suspicious (see `AnchorEntry`).
        const bucketRegistryId = entry["bucketRegistryId"];
        const originalPackageId = entry["originalPackageId"];
        const derivedUnder =
          typeof bucketRegistryId === "string" && typeof originalPackageId === "string"
            ? { bucketRegistryId, originalPackageId }
            : {};
        entries.push({ groupId, bucketId, creator, ...derivedUnder, recordedAt });
      }
      // Capped on READ as well as on write: a hand-edited (or future) file must
      // not be able to make one create enumerate an unbounded number of groups.
      if (entries.length === MAX_ANCHORS_PER_SPACE) break;
    }
    // A space whose every entry failed validation reads as having none at all,
    // rather than as an empty list, so `readAnchors` answers the same way it
    // does for a space nobody has ever created a bucket in.
    if (entries.length > 0) result[spaceId] = entries;
  }
  return result;
}

/** Persist the full anchors map, same atomic/mode discipline as `saveConfigFile`. */
function saveAnchors(data: AnchorsFileData): void {
  writeFileAtomic(getAnchorsFilePath(), `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
    mkdirMode: 0o700,
  });
}

/**
 * Every anchor group recorded for `spaceId`, most recent first — empty when the
 * space has none.
 *
 * There is deliberately no single-anchor reader beside this one. "The most
 * recent anchor" is precisely the query that produced the ratchet described at
 * the top of this file, and leaving a `readAnchor` in place would let it back in
 * one innocuous-looking call site at a time.
 *
 * A bare index is safe here only because `loadAnchors` builds a prototype-less
 * map — `spaceId` arrives straight from the `create_bucket` tool call, so on a
 * plain object literal this would answer `"constructor"` with a function. See
 * `emptyAnchors`.
 */
export function readAnchors(spaceId: string): readonly AnchorEntry[] {
  return loadAnchors()[spaceId] ?? [];
}

/**
 * Prepend a newly validated anchor group to `spaceId`'s list, leaving every
 * other space's entries untouched.
 *
 * Newest first, so the retention cap and the verifier's admitted-set cap both
 * drop the OLDEST evidence when they bite, and an entry for the same group id
 * (a repeated record of one create) moves to the front rather than appearing
 * twice — a duplicate would spend an anchor slot and a chain read on membership
 * that has already been counted.
 *
 * No lock guards this read-then-write (see the module comment): a write lost
 * to a concurrent racer just means that space keeps the anchors it already had,
 * which is always a safe outcome here — it can only under-permission.
 */
export function recordAnchor(spaceId: string, entry: AnchorEntry): void {
  const anchors = loadAnchors();
  const existing = anchors[spaceId] ?? [];
  anchors[spaceId] = [entry, ...existing.filter((other) => other.groupId !== entry.groupId)].slice(
    0,
    MAX_ANCHORS_PER_SPACE,
  );
  saveAnchors(anchors);
}
