import { describe, expect, it } from "vitest";
import { CONSOLE_API_BASE_URLS } from "../src/baseUrl";
import {
  MAINNET_PACKAGE_CONFIG,
  resolveFullnodeUrl,
  resolvePackageConfig,
  resolvePackageConfigForBaseUrl,
  resolveSuiNetwork,
  TESTNET_PACKAGE_CONFIG,
} from "../src/console/packageConfig";

describe("resolveSuiNetwork", () => {
  it("exact-matches the canonical Console hosts", () => {
    // The mainnet host carries no "mainnet" substring, so the default
    // configuration must never reach the heuristic.
    expect(resolveSuiNetwork(CONSOLE_API_BASE_URLS.mainnet)).toBe("mainnet");
    expect(resolveSuiNetwork(CONSOLE_API_BASE_URLS.testnet)).toBe("testnet");
  });

  it("derives testnet from a testnet-named host", () => {
    expect(resolveSuiNetwork("https://api.testnet.harbor.walrus.xyz")).toBe("testnet");
  });

  it("resolves testnet for local development", () => {
    expect(resolveSuiNetwork("http://localhost:2024")).toBe("testnet");
    expect(resolveSuiNetwork("http://127.0.0.1:2024")).toBe("testnet");
    // URL.hostname brackets IPv6 — "[::1]" is the only spelling that occurs.
    expect(resolveSuiNetwork("http://[::1]:2024")).toBe("testnet");
  });

  it("falls back to testnet for an unparseable base URL", () => {
    expect(resolveSuiNetwork("not a url")).toBe("testnet");
  });

  it("treats any other host as mainnet", () => {
    // The published package targets real users; testnet is opt-in. The
    // heuristic only ever sees non-canonical hosts (local stacks, internal
    // staging) — see the resolver's doc comment.
    expect(resolveSuiNetwork("https://api.mainnet.harbor.walrus.xyz")).toBe("mainnet");
    expect(resolveSuiNetwork("https://api.custom.walrus.xyz")).toBe("mainnet");
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
      packageId: "0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c",
      originalPackageId: "0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c",
      bucketRegistryId: "0x902841af0cd25c5f8dee4980fe2942687c9ca80db56d77ff67a4ba6d9d97b9cf",
      // Not built with locally — pinned because the sponsored create-bucket PTB
      // calls into it, so txValidation must allow exactly this package and no
      // other. Captured from a live testnet reserve.
      permissionedGroupPackageId:
        "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
    });
  });

  // Pins the 2026-09-01 mainnet publish. The point is that a re-sync cannot
  // half-update the mainnet block without a deliberate test change.
  it("pins the mainnet deploy", () => {
    expect(MAINNET_PACKAGE_CONFIG).toEqual({
      packageId: "0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c",
      // Fresh v1 publish, so the original id equals the package id.
      originalPackageId: "0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c",
      bucketRegistryId: "0x871f3d0341f36101ff0b30cd01dbe363f8d89d7f004df80e8084752d2f496958",
      // The mainnet sui-groups framework package, verified via MVR.
      permissionedGroupPackageId:
        "0x541840ae7df705d1c6329c22415ed61f9140a18b79b13c1c9dc7415b115c1ba8",
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
    expect(resolvePackageConfigForBaseUrl(CONSOLE_API_BASE_URLS.testnet)).toBe(
      TESTNET_PACKAGE_CONFIG,
    );
    expect(resolvePackageConfigForBaseUrl(CONSOLE_API_BASE_URLS.mainnet)).toBe(
      MAINNET_PACKAGE_CONFIG,
    );
    expect(resolvePackageConfigForBaseUrl("http://localhost:2024")).toBe(TESTNET_PACKAGE_CONFIG);
  });

  it("falls back to the network resolver on an unparseable base URL", () => {
    expect(resolvePackageConfigForBaseUrl("not a url")).toBe(TESTNET_PACKAGE_CONFIG);
  });
});
