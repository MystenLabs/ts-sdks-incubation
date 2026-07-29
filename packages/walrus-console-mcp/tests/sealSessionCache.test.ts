import { describe, expect, it } from "vitest";
import { canReuseSessionKey } from "../src/console/SealCryptoService";

/**
 * Unit tests for the SessionKey reuse predicate. The full decrypt() path is not
 * exercised here: it would require mocking four SDK surfaces at once
 * (@mysten/seal SessionKey/SealClient/EncryptedObject, @mysten/sui Transaction,
 * and the gRPC client) with no existing mock scaffolding in the repo. The only
 * new decision logic — when a cached key may be reused — is this pure predicate.
 */

const ADDR = "0xabc";
const fresh = { address: ADDR, sessionKey: { isExpired: () => false } };
const expired = { address: ADDR, sessionKey: { isExpired: () => true } };

describe("canReuseSessionKey", () => {
  it("returns false when there is no cached key", () => {
    expect(canReuseSessionKey(undefined, ADDR)).toBe(false);
  });

  it("returns true for a matching address that is not expired", () => {
    expect(canReuseSessionKey(fresh, ADDR)).toBe(true);
  });

  it("returns false when the cached key has expired", () => {
    expect(canReuseSessionKey(expired, ADDR)).toBe(false);
  });

  it("returns false when the signer address differs", () => {
    expect(canReuseSessionKey(fresh, "0xdifferent")).toBe(false);
  });
});
