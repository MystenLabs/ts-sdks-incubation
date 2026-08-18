import { describe, expect, it } from "vitest";
import {
  MAINNET_PACKAGE_CONFIG,
  resolveFullnodeUrl,
  resolvePackageConfig,
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
