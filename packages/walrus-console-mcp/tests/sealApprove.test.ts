import { describe, expect, it } from "vitest";
import { TESTNET_PACKAGE_CONFIG } from "../src/console/packageConfig";
import { buildSealApproveTransaction } from "../src/console/sealApprove";

const GROUP_ID = "0xd86830db0bcb6ab81c9ee4d44abf706cb73b19b3e42eaa99733ce70aab866a11";
const ID_BYTES = new Uint8Array([1, 2, 3, 4]);

describe("buildSealApproveTransaction", () => {
  it("targets seal_approve on the configured package", () => {
    const tx = buildSealApproveTransaction(TESTNET_PACKAGE_CONFIG, ID_BYTES, GROUP_ID);
    const [command] = tx.getData().commands;
    if (!command) throw new Error("expected a seal_approve command");

    expect(command.$kind).toBe("MoveCall");
    expect(command.MoveCall?.package).toBe(TESTNET_PACKAGE_CONFIG.packageId);
    expect(command.MoveCall?.module).toBe("bucket_policy");
    expect(command.MoveCall?.function).toBe("seal_approve");
  });

  /**
   * Asserted per position rather than over the serialized blob: `seal_approve`
   * takes `(id, registry, group)`, and both a registry/group swap and an empty
   * id vector keep every whole-transaction assertion green while reintroducing
   * exactly the failure this module exists to prevent. Nothing on the client
   * catches either — the key servers just refuse.
   */
  it("binds id, registry, and group to inputs 0, 1, 2 in that order", () => {
    const tx = buildSealApproveTransaction(TESTNET_PACKAGE_CONFIG, ID_BYTES, GROUP_ID);
    const { inputs, commands } = tx.getData();
    const [command] = commands;
    if (!command) throw new Error("expected a seal_approve command");

    expect(inputs).toHaveLength(3);
    // BCS `vector<u8>` of [1, 2, 3, 4]: a 0x04 ULEB length prefix then the bytes.
    // An empty id vector would serialize to "AA==" and fail here.
    expect(inputs[0]).toEqual({ $kind: "Pure", Pure: { bytes: "BAECAwQ=" } });
    expect(inputs[1]).toEqual({
      $kind: "UnresolvedObject",
      UnresolvedObject: { objectId: TESTNET_PACKAGE_CONFIG.bucketRegistryId },
    });
    expect(inputs[2]).toEqual({
      $kind: "UnresolvedObject",
      UnresolvedObject: { objectId: GROUP_ID },
    });

    // ...and that the call consumes those inputs positionally, not just that
    // three of them exist.
    expect(command.MoveCall?.arguments).toEqual([
      { $kind: "Input", Input: 0, type: "pure" },
      { $kind: "Input", Input: 1, type: "object" },
      { $kind: "Input", Input: 2, type: "object" },
    ]);
  });

  it("does not reference the retired pre-rebrand package", () => {
    const tx = buildSealApproveTransaction(TESTNET_PACKAGE_CONFIG, ID_BYTES, GROUP_ID);
    const serialized = JSON.stringify(tx.getData());

    expect(serialized).not.toContain(
      "0x8b2429358e9b0f005b69fe8ad3cbd1268ad87f35047a21612e082c64824faf8d",
    );
  });
});
