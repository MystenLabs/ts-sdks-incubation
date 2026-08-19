import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { TESTNET_PACKAGE_CONFIG } from "../src/console/packageConfig";
import { assertExpectedTransaction } from "../src/console/txValidation";
import fixtures from "./fixtures/sponsoredTransactions.json" with { type: "json" };

/**
 * These fixtures are REAL sponsored transactions captured from live testnet
 * Console (see scripts/capture-tx-fixtures.mts). That matters: the allowlist
 * below was derived from what Console actually builds, not from what the shape
 * of the API suggested it might build — and the two differ. The create-bucket
 * PTB spans three packages (bucket_policy, permissioned_group, and 0x2::transfer)
 * and varies its command count with the space's membership, neither of which was
 * guessable from the endpoint's signature.
 */

const cfg = TESTNET_PACKAGE_CONFIG;

const createBucketExpectation = { kind: "createBucket" } as const;

const grantExpectation = (scope: "read" | "readwrite") => {
  const f =
    scope === "readwrite" ? fixtures.grantBucketAccessReadWrite : fixtures.grantBucketAccessRead;
  return {
    kind: "grantBucketAccess",
    recipientAddress: f.recipientAddress,
    groupIds: f.groupIds,
    scope,
  } as const;
};

const WORKING = fixtures.workingAddress;
const ADMIN = fixtures.adminAddress;

const bytesFor = (scope: "read" | "readwrite") =>
  (scope === "readwrite" ? fixtures.grantBucketAccessReadWrite : fixtures.grantBucketAccessRead)
    .bytes;

/** A hostile PTB the endpoint could return instead of the real one. */
const forged = async (
  build: (tx: Transaction) => void,
  sender: string,
  gasOwner = "0x000000000000000000000000000000000000000000000000000000000000dead",
): Promise<string> => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(gasOwner);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);
  build(tx);
  return toBase64(await tx.build());
};

describe("the real transactions Console builds are accepted", () => {
  it("accepts the captured create-bucket reserve", () => {
    expect(() =>
      assertExpectedTransaction(fixtures.createBucket.bytes, WORKING, createBucketExpectation, cfg),
    ).not.toThrow();
  });

  it("accepts the captured readwrite grant", () => {
    expect(() =>
      assertExpectedTransaction(bytesFor("readwrite"), ADMIN, grantExpectation("readwrite"), cfg),
    ).not.toThrow();
  });

  it("accepts the captured read grant", () => {
    expect(() =>
      assertExpectedTransaction(bytesFor("read"), ADMIN, grantExpectation("read"), cfg),
    ).not.toThrow();
  });
});

describe("signing identity", () => {
  it("rejects a transaction whose sender is not us", () => {
    // Signing for a sender we are not is the clearest sign the bytes were not
    // built for this credential.
    expect(() =>
      assertExpectedTransaction(
        fixtures.createBucket.bytes,
        Ed25519Keypair.generate().toSuiAddress(),
        createBucketExpectation,
        cfg,
      ),
    ).toThrow(/sent by/i);
  });

  it("rejects the working-key flow presented with the admin transaction", () => {
    // Cross-flow substitution: the admin PTB is legitimate, just not something the
    // working key should ever be asked to sign.
    expect(() =>
      assertExpectedTransaction(bytesFor("readwrite"), WORKING, createBucketExpectation, cfg),
    ).toThrow();
  });
});

describe("scope is not advisory", () => {
  it("rejects a readwrite grant when read was requested", () => {
    // The whole point of asking for `read` is that the recipient cannot write.
    // add_editor where add_viewer was expected silently upgrades that.
    expect(() =>
      assertExpectedTransaction(bytesFor("readwrite"), ADMIN, grantExpectation("read"), cfg),
    ).toThrow(/add_editor|not permitted|scope/i);
  });
});

describe("recipient and targets cannot be substituted", () => {
  it("rejects a grant to an address we did not ask for", () => {
    const tampered = {
      ...grantExpectation("readwrite"),
      recipientAddress: Ed25519Keypair.generate().toSuiAddress(),
    };
    expect(() => assertExpectedTransaction(bytesFor("readwrite"), ADMIN, tampered, cfg)).toThrow(
      /recipient/i,
    );
  });

  it("rejects a grant touching a group we did not ask for", () => {
    const tampered = {
      ...grantExpectation("readwrite"),
      groupIds: [fixtures.grantBucketAccessReadWrite.groupIds[0] as string],
    };
    expect(() => assertExpectedTransaction(bytesFor("readwrite"), ADMIN, tampered, cfg)).toThrow(
      /group|object/i,
    );
  });
});

describe("forged transactions from a hostile endpoint", () => {
  const sender = fixtures.workingAddress;

  it("rejects a coin transfer disguised as a bucket reserve", async () => {
    // The headline attack: any endpoint that passes the base-URL allowlist could
    // return this and walk away with a signature that moves the signer's coins.
    const bytes = await forged((tx) => {
      const [coin] = tx.splitCoins(tx.gas, [1_000_000]);
      tx.transferObjects([coin!], `0x${"9".repeat(64)}`);
    }, sender);

    expect(() => assertExpectedTransaction(bytes, sender, createBucketExpectation, cfg)).toThrow(
      /SplitCoins|TransferObjects|only move calls/i,
    );
  });

  it("rejects a call into a package that is not ours", async () => {
    const bytes = await forged((tx) => {
      tx.moveCall({ target: `0x${"a".repeat(64)}::drainer::drain`, arguments: [] });
    }, sender);

    expect(() => assertExpectedTransaction(bytes, sender, createBucketExpectation, cfg)).toThrow(
      /does not use/i,
    );
  });

  it("rejects an unexpected function inside our own package", async () => {
    // Package-level allowlisting alone is not enough: our package has functions
    // that this flow has no business calling.
    const bytes = await forged((tx) => {
      tx.moveCall({ target: `${cfg.packageId}::bucket_policy::remove_admin`, arguments: [] });
    }, sender);

    expect(() => assertExpectedTransaction(bytes, sender, createBucketExpectation, cfg)).toThrow(
      /remove_admin/i,
    );
  });

  it("rejects a transaction we would be paying for ourselves", async () => {
    // These flows are sponsored — Console pays. A PTB billing our own gas coins is
    // not the flow we asked for, and gas coins are spendable value.
    const bytes = await forged(
      (tx) => {
        tx.moveCall({
          target: `${cfg.packageId}::bucket_policy::create_bucket_group`,
          arguments: [],
        });
      },
      sender,
      sender,
    );

    expect(() => assertExpectedTransaction(bytes, sender, createBucketExpectation, cfg)).toThrow(
      /not sponsored/i,
    );
  });

  it("rejects bytes that are not a transaction at all", () => {
    expect(() =>
      assertExpectedTransaction("bm90LWEtdHJhbnNhY3Rpb24=", WORKING, createBucketExpectation, cfg),
    ).toThrow();
  });
});
