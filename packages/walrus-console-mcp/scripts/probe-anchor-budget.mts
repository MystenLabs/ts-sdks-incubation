/**
 * Probe M11: does the roster verifier own its own anchor-enumeration budget,
 * or does it borrow one from `anchorStore.ts`?
 *
 * Background: clud-bot's finding claimed `authorVerifiedRoster`
 * (src/console/rosterVerification.ts) could be made to scan "dozens …
 * thousands" of anchors, because `MAX_ADMITTED_ANCHORS` (20) only bounds
 * anchors that get ADMITTED — an anchor that fails admission still costs an
 * enumeration and is never counted against that cap. On THIS tree the scale
 * claim is FALSE: `anchorStore.ts` read-caps `readAnchors(spaceId)` at
 * `MAX_ANCHORS_PER_SPACE` (32) on both write and read, so no caller that goes
 * through the store can ever hand the verifier more than 32 ids. Worst case
 * pre-fix was 32 enumerations, not thousands.
 *
 * That still leaves a real defence-in-depth gap: the verifier's own loop had
 * no bound of its own — it was correct only because it happened to be fed a
 * list some OTHER module had already capped. `MAX_CONSULTED_ANCHORS` (32,
 * this task) closes that: the loop now refuses to enumerate more than that
 * many anchors, however many ids it is handed and however many of them get
 * admitted.
 *
 * This probe demonstrates BOTH halves, from two different entry points:
 *
 *  (a) STORE PATH — `readAnchors(spaceId)`. Loads `tests/fixtures/
 *      anchors-oversized.json` (one space, 40 valid-shape entries) into a
 *      temp `XDG_CONFIG_HOME` and reads it back. Demonstrates the existing,
 *      UNCHANGED read cap: 32 entries out of 40 on disk, identically before
 *      and after this task's fix (this task touches nothing in
 *      `anchorStore.ts` except a comment).
 *
 *  (b) VERIFIER PATH — `authorVerifiedRoster`, called DIRECTLY with all 40 of
 *      the fixture's group ids (bypassing `readAnchors`'s cap entirely, the
 *      way a hand-edited file or a future non-store caller could), against a
 *      counting chain stub. The fixture's first anchor carries a candidate
 *      member (so the run reaches `chain_verified` and the `anchorsNotConsulted`
 *      field is actually reported — see the note below); the other 39 are
 *      identity-only and are never admitted, so the ADMITTED cap
 *      (`MAX_ADMITTED_ANCHORS`, 20) never trips and cannot be what bounds the
 *      read count.
 *
 *        Before this task's loop fix: 40 group reads (every id handed in gets
 *        enumerated) -> exit 1.
 *        After: 32 group reads and `anchorsNotConsulted: 8` -> exit 0.
 *
 *      NOTE on the OTHER empty-roster arm: when NOTHING is ever admitted, the
 *      result is `no_admitted_anchor`, and that arm deliberately omits
 *      `anchorsNotConsulted` (see the comment on that return arm in
 *      `rosterVerification.ts`) — it reports only via the read count, which is
 *      why this probe arranges for one anchor to be admitted: without that,
 *      the fixed bound would still be observable in the read count, but this
 *      probe could not print the disclosed field alongside it.
 *
 * No credentials, no network: `RosterChainDeps` is a hand-written counting
 * stub, exactly like `tests/rosterVerification.test.ts`'s `multiAnchorStub`.
 * Everything happens under a fresh temp directory this script creates and
 * removes.
 *
 * Run:  npx tsx scripts/probe-anchor-budget.mts
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect, Exit } from "effect";
import { getConfigDir } from "../src/configFile.js";
import {
  getAnchorsFilePath,
  MAX_ANCHORS_PER_SPACE,
  readAnchors,
} from "../src/console/anchorStore.js";
import type { SpaceSignersResponse } from "../src/console/ConsoleApiClient.js";
import { TESTNET_PACKAGE_CONFIG } from "../src/console/packageConfig.js";
import {
  authorVerifiedRoster,
  MAX_CONSULTED_ANCHORS,
  type MemberFieldPage,
  type RosterChainDeps,
  type SimulationRead,
} from "../src/console/rosterVerification.js";

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "..",
  "tests",
  "fixtures",
  "anchors-oversized.json",
);
const SPACE_ID = "space_probe_oversized";

const t0 = performance.now();
function mark(label: string): void {
  console.log(`[+${(performance.now() - t0).toFixed(1).padStart(7)}ms] ${label}`);
}

console.log("Anchor-budget probe (M11)\n");

// === (a) STORE PATH: readAnchors's existing, unchanged read cap ===========

const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "wcm-anchor-budget-"));
const originalXdg = process.env["XDG_CONFIG_HOME"];
process.env["XDG_CONFIG_HOME"] = tmpDir;

const fixtureRaw = fs.readFileSync(FIXTURE_PATH, "utf-8");
const fixtureData = JSON.parse(fixtureRaw) as Record<
  string,
  readonly { readonly groupId: string }[]
>;
const fixtureEntries = fixtureData[SPACE_ID] ?? [];
mark(`fixture on disk: ${fixtureEntries.length} entries for ${SPACE_ID}`);

fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
fs.writeFileSync(getAnchorsFilePath(), fixtureRaw);

const storeRead = readAnchors(SPACE_ID);
mark(
  `readAnchors("${SPACE_ID}") returned ${storeRead.length} entries (cap is ${MAX_ANCHORS_PER_SPACE})`,
);

if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
else process.env["XDG_CONFIG_HOME"] = originalXdg;
fs.rmSync(tmpDir, { recursive: true, force: true });

const storePathOk = storeRead.length === MAX_ANCHORS_PER_SPACE;
mark(
  storePathOk
    ? "store path: read-capped at 32, as expected (unchanged before/after this task)"
    : `store path: UNEXPECTED read count ${storeRead.length}, expected ${MAX_ANCHORS_PER_SPACE}`,
);

// === (b) VERIFIER PATH: authorVerifiedRoster's own enumeration budget =====

const OWNER = normalizeSuiAddress("0xf1");
const SIGNER = normalizeSuiAddress("0xf2");
const MANAGER = normalizeSuiAddress("0xf3");
const MEMBER = normalizeSuiAddress("0x1");

// Same construction as `tests/rosterVerification.test.ts`'s GROUP_TYPE / GroupContentBcs —
// duplicated rather than imported because neither is exported from
// `rosterVerification.ts`, and this probe must build the exact object shape
// `enumerateAnchorMembers` validates against.
const GroupContentBcs = bcs.struct("PermissionedGroup", {
  id: bcs.Address,
  permissions: bcs.struct("PermissionsTable", { id: bcs.Address, length: bcs.u64() }),
  permissionsAdminCount: bcs.u64(),
  creator: bcs.Address,
});
const WITNESS = `${normalizeSuiAddress(TESTNET_PACKAGE_CONFIG.originalPackageId)}::bucket_policy::WalrusConsole`;
const GROUP_TYPE = normalizeStructTag(
  `${normalizeSuiAddress(TESTNET_PACKAGE_CONFIG.permissionedGroupPackageId)}::permissioned_group::PermissionedGroup<${WITNESS}>`,
);
const tableOf = (groupId: string): string =>
  normalizeSuiAddress(`0x7ab1e${normalizeSuiAddress(groupId).slice(-8)}`);

const verifierAnchorIds = fixtureEntries.map((e) => normalizeSuiAddress(e.groupId));
mark(
  `verifier path: consulting all ${verifierAnchorIds.length} fixture ids directly (bypassing readAnchors)`,
);

// Anchor 0 carries the candidate member, so it gets ADMITTED (the run reaches
// `chain_verified` and `anchorsNotConsulted` is reported); every other anchor
// is identity-only and is never admitted, so the ADMITTED cap
// (`MAX_ADMITTED_ANCHORS`) cannot be what bounds the read count below.
const world = new Map<string, readonly string[]>(
  verifierAnchorIds.map((groupId, i) => [
    groupId,
    i === 0 ? [OWNER, MEMBER] : [OWNER, SIGNER, MANAGER],
  ]),
);
const byTable = new Map(verifierAnchorIds.map((groupId) => [tableOf(groupId), groupId]));

let groupReadCount = 0;

const deps: RosterChainDeps = {
  config: TESTNET_PACKAGE_CONFIG,
  getGroupObject: async (objectId) => {
    groupReadCount += 1;
    const members = world.get(objectId) ?? [];
    return {
      type: GROUP_TYPE,
      content: GroupContentBcs.serialize({
        id: objectId,
        permissions: { id: tableOf(objectId), length: BigInt(members.length) },
        permissionsAdminCount: 1n,
        creator: OWNER,
      }).toBytes(),
    };
  },
  listMemberFields: async (parentId): Promise<MemberFieldPage> => {
    const groupId = byTable.get(parentId) ?? "";
    const members = world.get(groupId) ?? [];
    return {
      dynamicFields: members.map((a) => ({
        name: { type: "address", bcs: bcs.Address.serialize(a).toBytes() },
      })),
      hasNextPage: false,
      cursor: null,
    };
  },
  simulate: async (): Promise<SimulationRead> => ({
    // Two `has_permission` calls per probed candidate; the only candidate ever
    // probed here (MEMBER, on the one admitted anchor) holds both roles.
    commandResults: [
      { returnValues: [{ bcs: new Uint8Array([1]) }] },
      { returnValues: [{ bcs: new Uint8Array([1]) }] },
    ],
  }),
};

const candidates: SpaceSignersResponse = {
  signers: [{ api_key_id: "probe-key", service_signer_address: MEMBER, scope: "readwrite" }],
};

const exit = await Effect.runPromiseExit(
  authorVerifiedRoster(deps, {
    anchorGroupIds: verifierAnchorIds,
    anchorCreators: [],
    ownerAddress: OWNER,
    signerAddress: SIGNER,
    managerAddress: MANAGER,
    listCandidates: () => Effect.succeed(candidates),
  }),
);

if (Exit.isFailure(exit)) {
  mark(`verifier path: authorVerifiedRoster REFUSED — ${JSON.stringify(exit.cause)}`);
  process.exit(1);
}

const result = exit.value;
mark(
  `verifier path: reason=${result.reason}, groupReads=${groupReadCount}, anchorsNotConsulted=${result.anchorsNotConsulted ?? "(absent)"}`,
);

const expectedNotConsulted = verifierAnchorIds.length - MAX_CONSULTED_ANCHORS;
const verifierPathOk =
  groupReadCount === MAX_CONSULTED_ANCHORS &&
  result.reason === "chain_verified" &&
  result.anchorsNotConsulted === expectedNotConsulted;

console.log();
if (!storePathOk) {
  console.log("FAIL — store path did not read-cap at 32; see above.");
  process.exit(1);
}
if (!verifierPathOk) {
  console.log(
    `BEFORE-FIX BEHAVIOUR OBSERVED — the verifier enumerated ${groupReadCount} of ` +
      `${verifierAnchorIds.length} anchors handed to it directly, instead of stopping at ` +
      `MAX_CONSULTED_ANCHORS (${MAX_CONSULTED_ANCHORS}). This is the M11 defence-in-depth gap: ` +
      `the loop's bound was borrowed from anchorStore's read cap rather than owned by the loop ` +
      `itself.`,
  );
  process.exit(1);
}

console.log(
  `PASS — store path read-caps at ${MAX_ANCHORS_PER_SPACE} (unchanged); verifier path, called ` +
    `directly with ${verifierAnchorIds.length} ids and none admitted past the first, still stops ` +
    `at ${MAX_CONSULTED_ANCHORS} enumerations and discloses anchorsNotConsulted: ${expectedNotConsulted}.`,
);
process.exit(0);
