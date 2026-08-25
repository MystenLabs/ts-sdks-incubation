import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLE_API_BASE_URL, isAllowedBaseUrl } from "../src/baseUrl";

describe("isAllowedBaseUrl", () => {
  it("allows the default testnet base URL", () => {
    expect(isAllowedBaseUrl(DEFAULT_CONSOLE_API_BASE_URL)).toBe(true);
  });

  it("allows https to walrus.xyz and its subdomains", () => {
    expect(isAllowedBaseUrl("https://walrus.xyz")).toBe(true);
    expect(isAllowedBaseUrl("https://api.mainnet.console.walrus.xyz")).toBe(true);
  });

  it("allows http and https to loopback for local dev", () => {
    expect(isAllowedBaseUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isAllowedBaseUrl("https://localhost")).toBe(true);
    expect(isAllowedBaseUrl("http://[::1]:3000")).toBe(true);
  });

  it("rejects non-loopback http (would send the Bearer key in the clear)", () => {
    expect(isAllowedBaseUrl("http://api.testnet.console.walrus.xyz")).toBe(false);
  });

  it("rejects hosts outside the walrus.xyz policy entirely", () => {
    expect(isAllowedBaseUrl("https://example.org")).toBe(false);
    expect(isAllowedBaseUrl("https://api.testnet.example.org")).toBe(false);
  });

  it("rejects a look-alike host that only shares a prefix (boundary-safe)", () => {
    expect(isAllowedBaseUrl("https://api.console.walrus.xyz-evil.com")).toBe(false);
    expect(isAllowedBaseUrl("https://xwalrus.xyz")).toBe(false);
    expect(isAllowedBaseUrl("https://walrus.xyz.evil.com")).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedBaseUrl("ftp://walrus.xyz")).toBe(false);
    expect(isAllowedBaseUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isAllowedBaseUrl("not a url")).toBe(false);
    expect(isAllowedBaseUrl("")).toBe(false);
  });
});
