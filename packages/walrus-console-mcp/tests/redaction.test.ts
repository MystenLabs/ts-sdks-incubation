import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSecrets,
  formatToolError,
  installLogRedaction,
  REDACTION_PLACEHOLDER,
  redactString,
  redactValue,
  registerSecret,
  registerSecretsFromEnv,
} from "../src/redaction.js";

// Realistic-shaped fakes — never real credentials, just long enough to register.
const API_KEY = "hbr_test_0123456789abcdef0123456789abcdef";
const SERVICE_KEY = "suiprivkey1q" + "z".repeat(40);

beforeEach(() => {
  clearSecrets();
});
afterEach(() => {
  clearSecrets();
});

describe("registerSecret", () => {
  it("redacts a registered value wherever it appears", () => {
    registerSecret(API_KEY);
    expect(redactString(`token=${API_KEY} done`)).toBe(`token=${REDACTION_PLACEHOLDER} done`);
  });

  it("replaces every occurrence, not just the first", () => {
    registerSecret(API_KEY);
    const out = redactString(`${API_KEY} and again ${API_KEY}`);
    expect(out).not.toContain(API_KEY);
    expect(out).toBe(`${REDACTION_PLACEHOLDER} and again ${REDACTION_PLACEHOLDER}`);
  });

  it("ignores empty and too-short values so common substrings survive", () => {
    registerSecret("");
    registerSecret("abc"); // below MIN_SECRET_LENGTH
    expect(redactString("abc and an empty string")).toBe("abc and an empty string");
  });

  it("leaves text without any secret untouched", () => {
    registerSecret(API_KEY);
    expect(redactString("nothing secret here")).toBe("nothing secret here");
  });
});

describe("registerSecretsFromEnv", () => {
  it("registers the WC API key and the service private key from the environment", () => {
    registerSecretsFromEnv({
      CONSOLE_API_KEY: API_KEY,
      CONSOLE_SERVICE_PRIVATE_KEY: SERVICE_KEY,
    } as NodeJS.ProcessEnv);

    const out = redactString(`api=${API_KEY} svc=${SERVICE_KEY}`);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(SERVICE_KEY);
  });
});

describe("redactValue", () => {
  it("scrubs a secret embedded in an Error's stack", () => {
    registerSecret(API_KEY);
    const err = new Error(`request failed with Authorization: Bearer ${API_KEY}`);
    const out = redactValue(err);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a secret nested inside an object (the HTTP-request leak shape)", () => {
    registerSecret(API_KEY);
    const requestLike = { method: "GET", headers: { Authorization: `Bearer ${API_KEY}` } };
    expect(redactValue(requestLike)).not.toContain(API_KEY);
  });
});

describe("formatToolError", () => {
  it("never reproduces a credential surfaced through an error message", () => {
    registerSecret(SERVICE_KEY);
    const err = new Error(`failed to decode key ${SERVICE_KEY}`);
    const out = formatToolError("upload_file", err);
    expect(out).not.toContain(SERVICE_KEY);
    expect(out).toContain("**Error in upload_file**");
  });
});

describe("installLogRedaction", () => {
  it("redacts secrets from every console method before they are written", () => {
    registerSecret(API_KEY);
    const written: string[] = [];
    // Console-shaped fake whose methods record what they would print.
    const fake = {
      log: (...a: unknown[]) => written.push(String(a[0])),
      error: (...a: unknown[]) => written.push(String(a[0])),
      warn: (...a: unknown[]) => written.push(String(a[0])),
      info: (...a: unknown[]) => written.push(String(a[0])),
      debug: (...a: unknown[]) => written.push(String(a[0])),
    } as unknown as Console;

    installLogRedaction(fake);
    fake.error("leaking", { headers: { Authorization: `Bearer ${API_KEY}` } });
    fake.log(`plain ${API_KEY}`);

    expect(written).toHaveLength(2);
    for (const line of written) {
      expect(line).not.toContain(API_KEY);
      expect(line).toContain(REDACTION_PLACEHOLDER);
    }
  });

  it("is idempotent — installing twice does not double-wrap", () => {
    registerSecret(API_KEY);
    const written: string[] = [];
    const fake = {
      log: (...a: unknown[]) => written.push(String(a[0])),
      error: (...a: unknown[]) => written.push(String(a[0])),
      warn: (...a: unknown[]) => written.push(String(a[0])),
      info: (...a: unknown[]) => written.push(String(a[0])),
      debug: (...a: unknown[]) => written.push(String(a[0])),
    } as unknown as Console;

    installLogRedaction(fake);
    installLogRedaction(fake);
    fake.log(`plain ${API_KEY}`);

    expect(written).toEqual([`plain ${REDACTION_PLACEHOLDER}`]);
  });
});
