import { describe, expect, it } from "vitest";
import {
  MAINNET_PACKAGE_CONFIG,
  resolveFullnodeUrl,
  resolvePackageConfig,
  resolvePackageConfigForBaseUrl,
  resolveSuiNetwork,
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

describe("resolvePackageConfigForBaseUrl", () => {
  it("resolves each network's host to that network's package set", () => {
    expect(resolvePackageConfigForBaseUrl("https://api.testnet.console.walrus.xyz")).toBe(
      TESTNET_PACKAGE_CONFIG,
    );
    expect(resolvePackageConfigForBaseUrl("https://api.mainnet.console.walrus.xyz")).toBe(
      MAINNET_PACKAGE_CONFIG,
    );
    expect(resolvePackageConfigForBaseUrl("http://localhost:2024")).toBe(TESTNET_PACKAGE_CONFIG);
  });

  it("falls back to the network resolver on an unparseable base URL", () => {
    expect(resolvePackageConfigForBaseUrl("not a url")).toBe(TESTNET_PACKAGE_CONFIG);
  });
});
