import { describe, expect, it } from "vitest";
import {
  MAINNET_PACKAGE_CONFIG,
  resolveFullnodeUrl,
  resolvePackageConfig,
  resolvePackageConfigForBaseUrl,
  resolveSuiNetwork,
  STAGING_TESTNET_PACKAGE_CONFIG,
  TESTNET_PACKAGE_CONFIG,
} from "../src/console/packageConfig";

describe("resolveSuiNetwork", () => {
  it("derives mainnet from a mainnet Console host", () => {
    expect(resolveSuiNetwork("https://api.mainnet.harbor.walrus.xyz")).toBe("mainnet");
  });

  it("derives testnet from a testnet Console host", () => {
    expect(resolveSuiNetwork("https://api.testnet.harbor.walrus.xyz")).toBe("testnet");
  });

  it("falls back to testnet for local development", () => {
    expect(resolveSuiNetwork("http://localhost:2024")).toBe("testnet");
    expect(resolveSuiNetwork("http://127.0.0.1:2024")).toBe("testnet");
  });

  it("falls back to testnet for an unparseable base URL", () => {
    expect(resolveSuiNetwork("not a url")).toBe("testnet");
  });
});

describe("resolvePackageConfig", () => {
  it("returns the testnet package config", () => {
    expect(resolvePackageConfig("testnet")).toBe(TESTNET_PACKAGE_CONFIG);
  });

  it("returns the mainnet package config", () => {
    expect(resolvePackageConfig("mainnet")).toBe(MAINNET_PACKAGE_CONFIG);
  });

  it("pins the current testnet deploy", () => {
    expect(TESTNET_PACKAGE_CONFIG).toEqual({
      packageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
      originalPackageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
      bucketRegistryId: "0x314fc86db4449e75f542015fd952513393b4671f6cf1dea01fd1f94697d97ab6",
      // Not built with locally — pinned because the sponsored create-bucket PTB
      // calls into it, so txValidation must allow exactly this package and no
      // other. Captured from a live testnet reserve.
      permissionedGroupPackageId:
        "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
    });
  });

  // Pins the placeholder values, not verified mainnet ids (COMG-584 is still
  // open). The point is that a re-sync cannot half-update the mainnet block
  // without a deliberate test change.
  it("pins the mainnet placeholder ids", () => {
    expect(MAINNET_PACKAGE_CONFIG).toEqual({
      packageId: "0x42e9f3b7d4ba898053835cbe8ff77bcd3580a1dc06820ae4e641fee11a455e9c",
      originalPackageId: "0x42e9f3b7d4ba898053835cbe8ff77bcd3580a1dc06820ae4e641fee11a455e9c",
      bucketRegistryId: "0x8fcff989d2f404b19e4a36c09add2166a76e7b1e73de3d3fb9afda003991270b",
      // Unknown, and deliberately left as the zero address: it makes a mainnet
      // create-bucket signature REFUSE rather than sign against a guessed package.
      permissionedGroupPackageId:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
  });

  it("does not carry the retired pre-rebrand package", () => {
    const retired = "0x8b2429358e9b0f005b69fe8ad3cbd1268ad87f35047a21612e082c64824faf8d";
    expect(Object.values(TESTNET_PACKAGE_CONFIG)).not.toContain(retired);
    expect(Object.values(MAINNET_PACKAGE_CONFIG)).not.toContain(retired);
  });
});

describe("resolveFullnodeUrl", () => {
  it("maps each network to its public fullnode", () => {
    expect(resolveFullnodeUrl("testnet")).toBe("https://fullnode.testnet.sui.io:443");
    expect(resolveFullnodeUrl("mainnet")).toBe("https://fullnode.mainnet.sui.io:443");
  });
});

/**
 * Host-keyed resolution exists because two Console deployments can sit on the
 * same Sui network while running different contract versions — the state during
 * a republish. Resolving by network alone there pins the wrong package, and
 * since `txValidation` allowlists exact packages, that refuses every signature.
 * Caught by the COMG-761 e2e, which failed exactly that way against staging.
 */
describe("resolvePackageConfigForBaseUrl", () => {
  it("gives the staging host the republished package set", () => {
    expect(resolvePackageConfigForBaseUrl("https://api.testnet.patestation.org")).toBe(
      STAGING_TESTNET_PACKAGE_CONFIG,
    );
  });

  it("keeps production testnet on the package set that host actually runs", () => {
    // The republish is unmerged; harbor main still carries these ids. Pointing
    // the default endpoint at the staging package would break every create.
    expect(resolvePackageConfigForBaseUrl("https://api.testnet.console.walrus.xyz")).toBe(
      TESTNET_PACKAGE_CONFIG,
    );
  });

  it("is host-exact, so a look-alike does not inherit the staging package", () => {
    expect(resolvePackageConfigForBaseUrl("https://api.testnet.patestation.org.evil.com")).toBe(
      TESTNET_PACKAGE_CONFIG,
    );
  });

  it("falls through to the network for an unlisted host", () => {
    expect(resolvePackageConfigForBaseUrl("https://api.mainnet.console.walrus.xyz")).toBe(
      MAINNET_PACKAGE_CONFIG,
    );
    expect(resolvePackageConfigForBaseUrl("http://localhost:2024")).toBe(TESTNET_PACKAGE_CONFIG);
  });

  it("falls back to the network resolver on an unparseable base URL", () => {
    expect(resolvePackageConfigForBaseUrl("not a url")).toBe(TESTNET_PACKAGE_CONFIG);
  });

  it("does not resolve a host that names an Object.prototype member", () => {
    // The host-keyed map is an object literal, so a bare index would answer
    // `constructor` or `toString` with a FUNCTION rather than a package config.
    // The base-URL allowlist keeps such a host from reaching here today; the
    // lookup must not depend on that to be correct.
    for (const host of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(resolvePackageConfigForBaseUrl(`https://${host}/`)).toBe(TESTNET_PACKAGE_CONFIG);
    }
  });

  it("pins the staging deploy's republished ids", () => {
    // Read back out of a live reserve from that deployment, not copied from a
    // document: harbor's constants for these live on an unmerged branch.
    expect(STAGING_TESTNET_PACKAGE_CONFIG).toEqual({
      packageId: "0xea146b35c7998a6da2db993a378058b3dffab71a60317ed2d587aecff6a498c6",
      originalPackageId: "0xea146b35c7998a6da2db993a378058b3dffab71a60317ed2d587aecff6a498c6",
      bucketRegistryId: "0xa425e58c5cb70069488301c9e296831ab7cecaa3ac547cabbad7f29dbf0bd83e",
      // Unchanged by the republish — sui-groups is versioned independently.
      permissionedGroupPackageId:
        "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
    });
  });

  it("does not let the staging entry drift onto production testnet", () => {
    expect(STAGING_TESTNET_PACKAGE_CONFIG.packageId).not.toBe(TESTNET_PACKAGE_CONFIG.packageId);
    expect(STAGING_TESTNET_PACKAGE_CONFIG.bucketRegistryId).not.toBe(
      TESTNET_PACKAGE_CONFIG.bucketRegistryId,
    );
  });
});
