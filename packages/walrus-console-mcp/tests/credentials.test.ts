import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NO_KEY_ADMIN_PIN_WARNING,
  NO_OWNER_PIN_WARNING,
  classifyProbe,
  collectCredentials,
  isEmptyWrite,
  isValidAdminKeyFormat,
  isValidApiKeyFormat,
  isValidServiceKeyFormat,
  keyKindOf,
  mismatchMessage,
  parseCredentialBundle,
  probeKey,
  suiAddressFromServiceKey,
  validateSilent,
} from "../src/credentials.js";
import { parseArgs } from "../src/cliArgs.js";
import {
  getConfigFilePath,
  loadConfigFile,
  mergeConfigFile,
  saveConfigFile,
} from "../src/configFile.js";
import { ALLOWED_DIRS_ENV, toRealPath } from "../src/pathSandbox.js";
import { SECRET_ENV_VARS, clearSecrets, redactString } from "../src/redaction.js";

/**
 * Real, decodable signers for tests that exercise `decodeSuiPrivateKey`
 * validation — a hand-typed placeholder like `suiprivkey1qqq…` no longer
 * passes format checks, since those now actually decode the value.
 */
const VALID_SIGNER = Ed25519Keypair.generate().getSecretKey();
const VALID_SIGNER_2 = Ed25519Keypair.generate().getSecretKey();

/** Well-formed prefix, wrong length/checksum — the "pasted garbage" case. */
const GARBLED_SIGNER = `suiprivkey1${"x".repeat(59)}`;

/** Shared fixtures for the bundle/address-pin flows. */
const OWNER_ADDRESS = `0x${"a".repeat(64)}`;
const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;
const STALE_ADDRESS = `0x${"9".repeat(64)}`;
const BUNDLE_API_KEY = "hbr_bundle_key_value";

/** Empty env so tests do not inherit a real `CONSOLE_WEB_ACCOUNT_ADDRESS`. */
const NO_ENV: NodeJS.ProcessEnv = {};

/** Stand-in value for probing which env vars `parseArgs` actually folds in. */
const ENV_SENTINEL = "sentinel-env-value";

/**
 * Does the installer fold this variable into `values` under `--silent`? Asked of
 * `parseArgs` itself rather than of a list copied into this test, so the answer
 * cannot drift from the code. `JSON.stringify` because `allowedDirs` lands as an
 * array while every other field is a bare string.
 */
const envVarIsRead = (name: string): boolean => {
  const { values } = parseArgs(["--silent"], { [name]: ENV_SENTINEL });
  return JSON.stringify(Object.values(values)).includes(ENV_SENTINEL);
};

/**
 * Not a Sui address, and `normalizeSuiAddress` does NOT throw on it — it
 * zero-pads it into `0x0000…totally-not-an-address`, which `loadConfigFile`
 * then re-checks and silently drops. That silent drop is what these tests exist
 * to prevent, so the value has to be one that survives normalization.
 */
const MALFORMED_ADDRESS = "totally-not-an-address";
/** Right shape, wrong length — normalizes to zero-padded junk rather than failing. */
const SHORT_HEX_ADDRESS = "0xabc";
/**
 * The worst seed of the three: `normalizeSuiAddress("")` is the ZERO address,
 * which `isValidSuiAddress` accepts and `loadConfigFile` therefore keeps. Junk
 * gets dropped on the next read; this one silently persists as a wrong pin.
 */
const ZERO_ADDRESS = `0x${"0".repeat(64)}`;

const bundleJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    apiKey: BUNDLE_API_KEY,
    servicePrivateKey: VALID_SIGNER,
    webAccountAddress: OWNER_ADDRESS,
    keyAdminAddress: KEY_ADMIN_ADDRESS,
    ...overrides,
  });

/**
 * The management-key shape of the same reveal. Its `keyAdminAddress` is the
 * address `VALID_SIGNER` derives, because that is the only value a real Console
 * reveal can carry — anything else is the disagreement the tests exercise
 * explicitly.
 */
const adminBundleJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    adminKey: "hbradm_management_key_value",
    adminServicePrivateKey: VALID_SIGNER,
    ownerAddress: OWNER_ADDRESS,
    keyAdminAddress: suiAddressFromServiceKey(VALID_SIGNER),
    ...overrides,
  });

describe("suiAddressFromServiceKey", () => {
  it("returns the Sui address of a valid suiprivkey1 signer", () => {
    const keypair = Ed25519Keypair.generate();
    const secret = keypair.getSecretKey();
    expect(suiAddressFromServiceKey(secret)).toBe(keypair.toSuiAddress());
  });

  // BOTH non-ED25519 schemes. With only secp256k1 asserted, a guard rewritten as
  // a denylist would pass this test and still derive a wrong address for an r1
  // key — the exact failure the check exists to prevent.
  it("refuses a structurally valid signer of another scheme instead of deriving a wrong address", () => {
    const k1 = Secp256k1Keypair.generate().getSecretKey();
    const r1 = Secp256r1Keypair.generate().getSecretKey();
    expect(() => suiAddressFromServiceKey(k1)).toThrow(/ED25519/);
    expect(() => suiAddressFromServiceKey(r1)).toThrow(/ED25519/);
  });
});

describe("format checks", () => {
  it("accepts a working key and rejects a management key", () => {
    expect(isValidApiKeyFormat("hbr_abcdefghijklmnop")).toBe(true);
    expect(isValidApiKeyFormat("hbradm_abcdefghijklmnop")).toBe(false);
  });

  it("accepts a management key and rejects a working key", () => {
    expect(isValidAdminKeyFormat("hbradm_abcdefghijklmnop")).toBe(true);
    expect(isValidAdminKeyFormat("hbr_abcdefghijklmnop")).toBe(false);
  });

  it("rejects empty and junk values", () => {
    expect(isValidApiKeyFormat("")).toBe(false);
    expect(isValidAdminKeyFormat("nope")).toBe(false);
    expect(isValidServiceKeyFormat("suiprivkey1abc")).toBe(false);
  });

  it("rejects a megabyte-long apiKey", () => {
    expect(isValidApiKeyFormat(`hbr_${"A".repeat(1_000_000)}`)).toBe(false);
    expect(isValidAdminKeyFormat(`hbradm_${"A".repeat(1_000_000)}`)).toBe(false);
  });

  it("rejects CRLF in a key", () => {
    expect(isValidApiKeyFormat("hbr_valid\r\nX-Injected-Header: x")).toBe(false);
    expect(isValidAdminKeyFormat("hbradm_valid\r\nX-Injected-Header: x")).toBe(false);
  });

  it("rejects NUL and BEL in a key", () => {
    expect(isValidApiKeyFormat("hbr_\u0000\u0007valid_looking_key")).toBe(false);
    expect(isValidAdminKeyFormat("hbradm_\u0000\u0007valid_looking_key")).toBe(false);
  });

  it("still accepts a Console-shaped url-safe body", () => {
    expect(isValidApiKeyFormat("hbr_5hgtau6RaBkUY6E-MCMmlAokzDOnHmex")).toBe(true);
    expect(isValidAdminKeyFormat("hbradm_3Fvv4HQ831a8Pe4lSAmbVwlmpvXGKjWh")).toBe(true);
  });

  // Same denylist-vs-allowlist reasoning as the derivation guard above.
  it("rejects a decodable signer that is not ED25519", () => {
    expect(isValidServiceKeyFormat(Secp256k1Keypair.generate().getSecretKey())).toBe(false);
    expect(isValidServiceKeyFormat(Secp256r1Keypair.generate().getSecretKey())).toBe(false);
    expect(isValidServiceKeyFormat(VALID_SIGNER)).toBe(true);
  });
});

describe("isValidServiceKeyFormat — real decode", () => {
  it("accepts a real generated Sui private key", () => {
    expect(isValidServiceKeyFormat(VALID_SIGNER)).toBe(true);
  });

  it("rejects a well-formed-looking but garbled key (bad checksum)", () => {
    expect(isValidServiceKeyFormat(GARBLED_SIGNER)).toBe(false);
  });

  it("rejects a key that merely has the right prefix and length heuristic", () => {
    // Would have passed the old startsWith + length > 20 heuristic.
    expect(isValidServiceKeyFormat(`suiprivkey1${"x".repeat(30)}`)).toBe(false);
  });
});

describe("keyKindOf", () => {
  it("identifies each prefix and returns null otherwise", () => {
    expect(keyKindOf("hbr_abcdefghijklmnop")).toBe("api");
    expect(keyKindOf("hbradm_abcdefghijklmnop")).toBe("admin");
    expect(keyKindOf("suiprivkey1qqqqqqqqqqqqqqqqqqqqqq")).toBeNull();
  });
});

describe("mismatchMessage", () => {
  it("explains a management key pasted into the API-key step", () => {
    const msg = mismatchMessage("api", "hbradm_abcdefghijklmnop");
    expect(msg).toContain("management key");
    expect(msg).toContain("hbr_");
  });

  it("explains a working key pasted into the management step", () => {
    const msg = mismatchMessage("admin", "hbr_abcdefghijklmnop");
    expect(msg).toContain("everyday API key");
    expect(msg).toContain("hbradm_");
  });

  it("returns null when the type matches", () => {
    expect(mismatchMessage("api", "hbr_abcdefghijklmnop")).toBeNull();
    expect(mismatchMessage("admin", "hbradm_abcdefghijklmnop")).toBeNull();
  });
});

describe("classifyProbe", () => {
  it("maps working-key statuses", () => {
    expect(classifyProbe("api", 200)).toBe("ok");
    expect(classifyProbe("api", 401)).toBe("invalid");
    expect(classifyProbe("api", 403)).toBe("wrong-scope");
  });

  // Statuses observed live against a real Console: a valid management key gets
  // 404 on the deliberately-absent probe id, a working key gets 403 there, and a
  // revoked key gets 401.
  it("accepts a management key only on the deliberate 404 or a 2xx", () => {
    expect(classifyProbe("admin", 404)).toBe("ok");
    expect(classifyProbe("admin", 200)).toBe("ok");
    expect(classifyProbe("admin", 204)).toBe("ok");
    expect(classifyProbe("admin", 401)).toBe("invalid");
    expect(classifyProbe("admin", 403)).toBe("wrong-scope");
  });

  // Regression: everything except 401/403 used to return "ok" for a management
  // key, so an upstream outage read as "verified" and an unusable credential was
  // persisted — failing later at mint time with no clue why.
  it("does not accept a management key when the upstream is failing", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyProbe("admin", status)).toBe("unreachable");
    }
  });

  it("does not blame the working key for an upstream failure either", () => {
    for (const status of [429, 500, 503]) {
      expect(classifyProbe("api", status)).toBe("unreachable");
    }
  });

  // A status that is neither a success signal nor a recognised upstream failure
  // proves nothing about the credential, so it must not be accepted.
  it("rejects an unexpected status rather than accepting it", () => {
    expect(classifyProbe("admin", 400)).toBe("invalid");
    expect(classifyProbe("admin", 418)).toBe("invalid");
    expect(classifyProbe("api", 404)).toBe("invalid");
  });
});

describe("probeKey", () => {
  const baseUrl = "https://api.example.test";

  it("calls /api/v1/spaces for a working key", async () => {
    let seen = "";
    const fake = (async (url: string | URL) => {
      seen = String(url);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await probeKey("api", "hbr_x", baseUrl, fake)).toBe("ok");
    expect(seen).toBe(`${baseUrl}/api/v1/spaces`);
  });

  it("calls the key-admin control-plane route for a management key", async () => {
    let seen = "";
    let auth = "";
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen = String(url);
      auth = String((init?.headers as Record<string, string>)?.["Authorization"] ?? "");
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    expect(await probeKey("admin", "hbradm_x", baseUrl, fake)).toBe("ok");
    expect(seen).toBe(`${baseUrl}/api/v1/api-keys/00000000-0000-0000-0000-000000000000`);
    expect(auth).toBe("Bearer hbradm_x");
  });

  it("reports a wrong-scope management probe", async () => {
    const fake = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    expect(await probeKey("admin", "hbr_x", baseUrl, fake)).toBe("wrong-scope");
  });

  it("returns unreachable when the request throws", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeKey("admin", "hbradm_x", baseUrl, fake)).toBe("unreachable");
  });
});

/** Scripted prompter: answers come from a queue; questions are recorded. */
const scriptedDeps = (answers: string[]) => {
  const asked: string[] = [];
  /** `opts.masked` per question, so a test can assert what was hidden. */
  const askedMasked: (boolean | undefined)[] = [];
  const messages: string[] = [];
  return {
    asked,
    askedMasked,
    messages,
    deps: {
      ask: async (question: string, opts?: { masked?: boolean }) => {
        asked.push(question);
        askedMasked.push(opts?.masked);
        return answers.shift() ?? "";
      },
      ok: (m: string) => messages.push(`ok:${m}`),
      fail: (m: string) => messages.push(`fail:${m}`),
      warn: (m: string) => messages.push(`warn:${m}`),
      info: (m: string) => messages.push(`info:${m}`),
      show: (m: string) => messages.push(`show:${m}`),
      probe: async () => "ok" as const,
    },
  };
};

describe("collectCredentials", () => {
  it("api: collects the key and the optional signer", async () => {
    const { deps } = scriptedDeps(["hbr_working_key_value", VALID_SIGNER]);
    const { updates } = await collectCredentials("api", deps);
    expect(updates).toEqual({
      apiKey: "hbr_working_key_value",
      servicePrivateKey: VALID_SIGNER,
    });
  });

  it("api: an empty signer is skipped, not saved", async () => {
    const { deps } = scriptedDeps(["hbr_working_key_value", ""]);
    const { updates } = await collectCredentials("api", deps);
    expect(updates).toEqual({ apiKey: "hbr_working_key_value" });
  });

  it("api: a garbled signer is rejected and re-prompts until a real key is given", async () => {
    const { deps, messages } = scriptedDeps([
      "hbr_working_key_value",
      GARBLED_SIGNER,
      VALID_SIGNER,
    ]);
    const { updates } = await collectCredentials("api", deps);
    expect(updates).toEqual({
      apiKey: "hbr_working_key_value",
      servicePrivateKey: VALID_SIGNER,
    });
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("decode"))).toBe(true);
    // The garbled value itself must never appear in a message.
    expect(messages.some((m) => m.includes(GARBLED_SIGNER))).toBe(false);
  });

  it("admin: both halves are required", async () => {
    const { deps, asked } = scriptedDeps([
      "hbradm_management_key",
      "", // empty signer -> re-prompt
      VALID_SIGNER,
    ]);
    const { updates } = await collectCredentials("admin", deps);
    expect(updates).toEqual({
      adminKey: "hbradm_management_key",
      adminServicePrivateKey: VALID_SIGNER,
      keyAdminAddress: suiAddressFromServiceKey(VALID_SIGNER),
    });
    expect(asked.filter((q) => q.includes("ADMIN_SERVICE_PRIVATE_KEY")).length).toBe(2);
  });

  it("admin: a garbled signer is rejected and re-prompts until a real key is given", async () => {
    const { deps, messages } = scriptedDeps([
      "hbradm_management_key",
      GARBLED_SIGNER,
      VALID_SIGNER,
    ]);
    const { updates } = await collectCredentials("admin", deps);
    expect(updates.adminServicePrivateKey).toBe(VALID_SIGNER);
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("decode"))).toBe(true);
  });

  it("rejects a management key pasted into the api step and re-prompts", async () => {
    const { deps, messages } = scriptedDeps(["hbradm_wrong_slot", "hbr_working_key_value", ""]);
    const { updates } = await collectCredentials("api", deps);
    expect(updates.apiKey).toBe("hbr_working_key_value");
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("management key"))).toBe(true);
  });

  it("rejects a working key pasted into the admin step and re-prompts", async () => {
    const { deps, messages } = scriptedDeps([
      "hbr_wrong_slot",
      "hbradm_management_key",
      VALID_SIGNER,
    ]);
    const { updates } = await collectCredentials("admin", deps);
    expect(updates.adminKey).toBe("hbradm_management_key");
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("everyday API key"))).toBe(
      true,
    );
  });

  it("re-prompts when the probe rejects the key", async () => {
    const answers = ["hbr_rejected_key", "hbr_working_key_value", ""];
    const asked: string[] = [];
    let call = 0;
    const { updates } = await collectCredentials("api", {
      ask: async (q: string) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
      ok: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      show: () => {},
      probe: async () => (call++ === 0 ? "invalid" : "ok"),
    });
    expect(updates.apiKey).toBe("hbr_working_key_value");
  });

  it("both: collects all four, working pair first", async () => {
    const { deps, asked } = scriptedDeps([
      "hbr_working_key_value",
      VALID_SIGNER,
      "hbradm_management_key",
      VALID_SIGNER_2,
    ]);
    const { updates } = await collectCredentials("both", deps);
    expect(updates).toEqual({
      apiKey: "hbr_working_key_value",
      servicePrivateKey: VALID_SIGNER,
      adminKey: "hbradm_management_key",
      adminServicePrivateKey: VALID_SIGNER_2,
      keyAdminAddress: suiAddressFromServiceKey(VALID_SIGNER_2),
    });
    expect(asked[0]).toContain("CONSOLE_API_KEY");
    expect(asked[2]).toContain("CONSOLE_ADMIN_KEY");
  });
});

describe("collectCredentials — credential bundle", () => {
  it("writes the key, the signer and both pins after an explicit confirmation", async () => {
    const { deps, asked, messages } = scriptedDeps([bundleJson(), "y"]);

    const { updates, clear } = await collectCredentials("bundle", deps);

    expect(updates).toEqual({
      apiKey: BUNDLE_API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
    expect(clear).toEqual([]);
    // Both addresses are shown, unmasked, BEFORE the confirmation — the display
    // is the whole trust step.
    expect(messages.join("\n")).toContain(OWNER_ADDRESS);
    expect(messages.join("\n")).toContain(KEY_ADMIN_ADDRESS);
    expect(asked[1]).toMatch(/\[y\/N\]/);
  });

  it("masks the paste but not the confirmation", async () => {
    const { deps, askedMasked } = scriptedDeps([bundleJson(), "y"]);

    await collectCredentials("bundle", deps);

    // The bundle carries a live key and signer: it is a secret.
    expect(askedMasked[0]).not.toBe(false);
    // The confirmation answer is not, and masking it would hide the y/N.
    expect(askedMasked[1]).toBe(false);
  });

  it("writes NOTHING when the confirmation is declined", async () => {
    const { deps } = scriptedDeps([bundleJson(), "n"]);

    const write = await collectCredentials("bundle", deps, {
      webAccountAddress: STALE_ADDRESS,
    });

    expect(write.updates).toEqual({});
    expect(write.clear).toEqual([]);
    expect(isEmptyWrite(write)).toBe(true);
  });

  it("treats a bare Enter as a decline — the confirmation must be affirmative", async () => {
    const { deps } = scriptedDeps([bundleJson(), ""]);

    const write = await collectCredentials("bundle", deps);

    expect(isEmptyWrite(write)).toBe(true);
  });

  it("accepts a spelled-out yes", async () => {
    const { deps } = scriptedDeps([bundleJson(), "YES"]);

    const { updates } = await collectCredentials("bundle", deps);

    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
  });

  // The bundle is authoritative for the pins: a `null` means THIS key has no
  // such address, so a value saved for a previous key must go.
  it("clears a stale owner pin the bundle carries as null", async () => {
    const { deps } = scriptedDeps([bundleJson({ webAccountAddress: null }), "y"]);

    const { updates, clear } = await collectCredentials("bundle", deps, {
      webAccountAddress: STALE_ADDRESS,
    });

    expect(updates.webAccountAddress).toBeUndefined();
    expect(clear).toContain("webAccountAddress");
    expect(clear).not.toContain("keyAdminAddress");
  });

  it("clears a stale Key-Admin pin the bundle carries as null", async () => {
    const { deps } = scriptedDeps([bundleJson({ keyAdminAddress: null }), "y"]);

    const { updates, clear } = await collectCredentials("bundle", deps, {
      keyAdminAddress: STALE_ADDRESS,
    });

    expect(updates.keyAdminAddress).toBeUndefined();
    expect(clear).toContain("keyAdminAddress");
  });

  it("clears BOTH stale pins when the bundle carries both as null", async () => {
    const { deps, messages } = scriptedDeps([
      bundleJson({ webAccountAddress: null, keyAdminAddress: null }),
      "y",
    ]);

    const { updates, clear } = await collectCredentials("bundle", deps, {
      webAccountAddress: STALE_ADDRESS,
      keyAdminAddress: STALE_ADDRESS,
    });

    expect(updates).toEqual({ apiKey: BUNDLE_API_KEY, servicePrivateKey: VALID_SIGNER });
    expect(clear).toEqual(["webAccountAddress", "keyAdminAddress"]);
    // Both are shown as absent, and both warnings fire.
    expect(messages.filter((m) => m.includes("(none in this bundle)")).length).toBe(2);
    expect(messages.filter((m) => m.startsWith("warn:") && m.includes("Key-Admin")).length).toBe(1);
  });

  it("saves the credentials and warns loudly when the bundle has no owner", async () => {
    const { deps, messages } = scriptedDeps([bundleJson({ webAccountAddress: null }), "y"]);

    const { updates } = await collectCredentials("bundle", deps);

    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
    expect(updates.servicePrivateKey).toBe(VALID_SIGNER);
    expect(messages.some((m) => m.startsWith("warn:") && m.includes("create_bucket"))).toBe(true);
  });

  it("re-prompts on a malformed bundle without ever echoing the paste", async () => {
    const junk = '{"v":1,"apiKey":"hbr_x","serviceSecret":"NEVER_ECHO_THIS_VALUE"}';
    const { deps, messages } = scriptedDeps([junk, bundleJson(), "y"]);

    const { updates } = await collectCredentials("bundle", deps);

    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
    expect(messages.some((m) => m.startsWith("fail:"))).toBe(true);
    expect(messages.join("\n")).not.toContain("NEVER_ECHO_THIS_VALUE");
    expect(messages.join("\n")).not.toContain(junk);
  });

  it("re-prompts on an empty paste", async () => {
    const { deps, asked } = scriptedDeps(["", bundleJson(), "y"]);

    const { updates } = await collectCredentials("bundle", deps);

    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
    expect(asked.filter((q) => q.includes("CONSOLE_CREDENTIAL_BUNDLE")).length).toBe(2);
  });

  it("does not confirm or write a bundle whose API key the probe rejects", async () => {
    const answers = [bundleJson(), bundleJson(), "y"];
    const asked: string[] = [];
    let call = 0;
    const { updates } = await collectCredentials("bundle", {
      ask: async (q: string) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
      ok: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      show: () => {},
      probe: async () => (call++ === 0 ? "invalid" : "ok"),
    });

    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
    // Prompt, (rejected — no confirmation), prompt, confirmation.
    expect(asked.filter((q) => /\[y\/N\]/.test(q)).length).toBe(1);
  });

  it("probes the bundle's key as a working key, not a management key", async () => {
    const kinds: string[] = [];
    const answers = [bundleJson(), "y"];
    await collectCredentials("bundle", {
      ask: async () => answers.shift() ?? "",
      ok: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      show: () => {},
      probe: async (kind) => {
        kinds.push(kind);
        return "ok" as const;
      },
    });
    expect(kinds).toEqual(["api"]);
  });

  it("probes an admin bundle as a management key and derives the pin", async () => {
    const adminKey = "hbradm_management_key_value";
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const raw = JSON.stringify({
      v: 1,
      adminKey,
      adminServicePrivateKey: VALID_SIGNER,
      ownerAddress: OWNER_ADDRESS,
      keyAdminAddress: derived,
    });
    const kinds: string[] = [];
    const answers = [raw, "y"];
    const messages: string[] = [];
    const { updates } = await collectCredentials("bundle", {
      ask: async () => answers.shift() ?? "",
      ok: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      show: (m) => messages.push(m),
      probe: async (kind) => {
        kinds.push(kind);
        return "ok" as const;
      },
    });
    expect(kinds).toEqual(["admin"]);
    expect(updates.adminKey).toBe(adminKey);
    expect(updates.adminServicePrivateKey).toBe(VALID_SIGNER);
    expect(updates.keyAdminAddress).toBe(derived);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(messages).toContain(OWNER_ADDRESS);
    expect(messages).toContain(derived);
  });

  // An admin bundle configures a provisioning host just as the Management key
  // prompt does, so it owes the operator the same warning: this file mints
  // credentials and must not be copied to workers.
  it("warns that an admin bundle configures a provisioning host", async () => {
    const { deps, messages } = scriptedDeps([adminBundleJson(), "y"]);

    await collectCredentials("bundle", deps);

    expect(
      messages.some((m) => m.startsWith("warn:") && m.includes("Provisioning host only")),
    ).toBe(true);
  });

  it("an admin bundle whose keyAdminAddress disagrees with its own signer is refused", async () => {
    const { deps, messages } = scriptedDeps([
      adminBundleJson({ keyAdminAddress: STALE_ADDRESS }),
      "y",
    ]);

    const write = await collectCredentials("bundle", deps);

    expect(isEmptyWrite(write)).toBe(true);
    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(STALE_ADDRESS);
    expect(failure).toContain(suiAddressFromServiceKey(VALID_SIGNER));
  });

  it("a seed that disagrees with the pasted bundle is refused, naming both, then re-prompts", async () => {
    const { deps, messages } = scriptedDeps([
      bundleJson({ webAccountAddress: STALE_ADDRESS }),
      bundleJson(),
      "y",
    ]);

    const { updates } = await collectCredentials(
      "bundle",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS },
    );

    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(STALE_ADDRESS);
    expect(failure).toContain(OWNER_ADDRESS);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("a Key-Admin seed where the bundle says null is a disagreement", async () => {
    const { deps, messages } = scriptedDeps([
      bundleJson({ keyAdminAddress: null }),
      bundleJson(),
      "y",
    ]);

    await collectCredentials("bundle", deps, {}, { keyAdminAddress: KEY_ADMIN_ADDRESS });

    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(KEY_ADMIN_ADDRESS);
    expect(failure).toContain("no such address");
  });

  // A management key never calls `create_bucket`, so its reveal is not the
  // account's answer for the owner pin the way a working bundle's is. Saying
  // nothing about the owner must leave the saved one alone — and must not then
  // warn about an absence that is not there. Surviving the write and being
  // described honestly are one rule (`pinSurvives`), so both paths assert both.
  it("an admin bundle carrying no owner leaves a saved owner pin alone, and does not warn", async () => {
    const { deps, messages } = scriptedDeps([adminBundleJson({ ownerAddress: undefined }), "y"]);

    const { updates, clear } = await collectCredentials("bundle", deps, {
      webAccountAddress: OWNER_ADDRESS,
    });

    expect(clear).not.toContain("webAccountAddress");
    expect(updates.webAccountAddress).toBeUndefined();
    expect(messages).not.toContain(`warn:${NO_OWNER_PIN_WARNING}`);
  });

  // The Console's Connect MCP panel copies `--key-admin-address`, so this pairing
  // is the common flow, not an edge case. `null` in an ADMIN bundle means "not
  // supplied" — the signer answers it — so the seed must be compared against the
  // derivation rather than refused against the absence.
  it("a Key-Admin seed equal to an admin bundle's derived address proceeds without looping", async () => {
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const { deps, asked } = scriptedDeps([adminBundleJson({ keyAdminAddress: null }), "y"]);

    const { updates } = await collectCredentials("bundle", deps, {}, { keyAdminAddress: derived });

    expect(updates.keyAdminAddress).toBe(derived);
    // One paste, not a re-prompt loop.
    expect(asked.filter((q) => q.includes("CONSOLE_CREDENTIAL_BUNDLE"))).toHaveLength(1);
  });

  it("a Key-Admin seed that differs from an admin bundle's derived address refuses without looping", async () => {
    const { deps, messages, asked } = scriptedDeps([
      adminBundleJson({ keyAdminAddress: null }),
      "y",
    ]);

    const write = await collectCredentials("bundle", deps, {}, { keyAdminAddress: STALE_ADDRESS });

    expect(isEmptyWrite(write)).toBe(true);
    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(STALE_ADDRESS);
    expect(failure).toContain(suiAddressFromServiceKey(VALID_SIGNER));
    expect(asked.filter((q) => q.includes("CONSOLE_CREDENTIAL_BUNDLE"))).toHaveLength(1);
  });

  it("an admin bundle with keyAdminAddress null persists the derived pin", async () => {
    const { deps } = scriptedDeps([adminBundleJson({ keyAdminAddress: null }), "y"]);

    const { updates, clear } = await collectCredentials("bundle", deps);

    expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));
    expect(clear).not.toContain("keyAdminAddress");
  });

  // The owner half of the same rule. A management bundle never calls
  // `create_bucket`, so it has nothing to say about the owner: an absent owner
  // is "not supplied", not "there is none", and the seed is the only thing that
  // can supply it. Refusing it here was an unescapable `deps.fail(); continue` —
  // exactly the loop the Key-Admin case above already fixed.
  it("an owner seed fills the owner an admin bundle does not carry", async () => {
    const { deps, asked } = scriptedDeps([adminBundleJson({ ownerAddress: undefined }), "y"]);

    const { updates, clear } = await collectCredentials(
      "bundle",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS },
    );

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(clear).not.toContain("webAccountAddress");
    // One paste, not a re-prompt loop.
    expect(asked.filter((q) => q.includes("CONSOLE_CREDENTIAL_BUNDLE"))).toHaveLength(1);
  });

  it("an owner seed fills an admin bundle's explicit null owner too", async () => {
    const { deps } = scriptedDeps([adminBundleJson({ ownerAddress: null }), "y"]);

    const { updates } = await collectCredentials(
      "bundle",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS },
    );

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  // The `[y/N]` must confirm the value that will actually be written, not the
  // bundle's own empty field — the unmasked display IS the trust step.
  it("shows the seeded owner before the confirmation, not '(none in this bundle)'", async () => {
    const { deps, messages } = scriptedDeps([adminBundleJson({ ownerAddress: undefined }), "y"]);

    await collectCredentials("bundle", deps, {}, { ownerAddress: OWNER_ADDRESS });

    expect(messages).toContain(`show:${OWNER_ADDRESS}`);
    expect(messages).not.toContain("show:(none in this bundle)");
  });

  // `pinSurvives` reads the resolved write, so the seed silences the warning
  // with no extra rule. Asserted rather than assumed.
  it("does not warn about a missing owner pin once the seed resolved it", async () => {
    const { deps, messages } = scriptedDeps([adminBundleJson({ ownerAddress: undefined }), "y"]);

    await collectCredentials("bundle", deps, {}, { ownerAddress: OWNER_ADDRESS });

    expect(messages).not.toContain(`warn:${NO_OWNER_PIN_WARNING}`);
  });

  it("an owner seed that disagrees with an admin bundle's own owner still refuses", async () => {
    const { deps, messages } = scriptedDeps([
      adminBundleJson({ ownerAddress: STALE_ADDRESS }),
      adminBundleJson(),
      "y",
    ]);

    const { updates } = await collectCredentials(
      "bundle",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS },
    );

    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(STALE_ADDRESS);
    expect(failure).toContain(OWNER_ADDRESS);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  // C1 turned this seed from something merely COMPARED into something WRITTEN,
  // and `normalizeSuiAddress` zero-pads junk instead of rejecting it — so an
  // unvalidated seed reaches the config file as `0x0000…junk`, where
  // `loadConfigFile` silently drops it (src/configFile.ts:130-132). The operator
  // is told the pin saved and every later `create_bucket` refuses: exactly the
  // silent-discard class this PR exists to close. No paste can fix a bad flag,
  // so this refuses outright rather than re-prompting.
  it("refuses a malformed owner seed outright, without pasting or looping", async () => {
    const { deps, asked, messages } = scriptedDeps([
      adminBundleJson({ ownerAddress: undefined }),
      "y",
    ]);

    const write = await collectCredentials("bundle", deps, {}, { ownerAddress: MALFORMED_ADDRESS });

    expect(isEmptyWrite(write)).toBe(true);
    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain("--owner-address");
    expect(failure).toContain("not a valid Sui address");
    // Names the flag, never the value — a mis-pasted secret can land here.
    expect(failure).not.toContain(MALFORMED_ADDRESS);
    // Not even one prompt: re-pasting the bundle cannot fix a bad flag.
    expect(asked.filter((q) => q.includes("CONSOLE_CREDENTIAL_BUNDLE"))).toHaveLength(0);
  });

  it("refuses a malformed Key-Admin seed outright too", async () => {
    const { deps, messages } = scriptedDeps([adminBundleJson(), "y"]);

    const write = await collectCredentials(
      "bundle",
      deps,
      {},
      { keyAdminAddress: SHORT_HEX_ADDRESS },
    );

    expect(isEmptyWrite(write)).toBe(true);
    expect(messages.find((m) => m.startsWith("fail:"))).toContain("--key-admin-address");
  });

  // A WORKING bundle IS the account's answer for the owner, so its `null` means
  // "this key has no such address" — something a seed genuinely contradicts.
  // Unchanged by the management-bundle relaxation.
  it("an owner seed against a working bundle's null owner is still a disagreement", async () => {
    const { deps, messages } = scriptedDeps([
      bundleJson({ webAccountAddress: null }),
      bundleJson(),
      "y",
    ]);

    await collectCredentials("bundle", deps, {}, { ownerAddress: OWNER_ADDRESS });

    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(OWNER_ADDRESS);
    expect(failure).toContain("no such address");
  });
});

// Round 1 guarded the bundle path; these are the same defect in the branch it
// did not reach. `collectCredentials("api" | "admin" | "both")` pushed
// `seeds.ownerAddress` straight into `updates` after the confirm, on the
// assumption that `parseArgs` had validated it — the exact assumption rejected
// for `collectBundle`. The guard now sits at the top of `collectCredentials`,
// so it covers every choice including "bundle".
describe("collectCredentials — malformed address seeds", () => {
  it("api: refuses a malformed owner seed before prompting for anything", async () => {
    const { deps, asked, messages } = scriptedDeps(["hbr_working_key_value", VALID_SIGNER]);

    const write = await collectCredentials("api", deps, {}, { ownerAddress: MALFORMED_ADDRESS });

    expect(isEmptyWrite(write)).toBe(true);
    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain("--owner-address");
    expect(failure).toContain("not a valid Sui address");
    expect(failure).not.toContain(MALFORMED_ADDRESS);
    // A bad flag cannot be fixed by answering a prompt, so none is asked.
    expect(asked).toHaveLength(0);
  });

  it("admin: refuses a malformed Key-Admin seed before prompting", async () => {
    const { deps, asked, messages } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER]);

    const write = await collectCredentials(
      "admin",
      deps,
      {},
      { keyAdminAddress: SHORT_HEX_ADDRESS },
    );

    expect(isEmptyWrite(write)).toBe(true);
    expect(messages.find((m) => m.startsWith("fail:"))).toContain("--key-admin-address");
    expect(asked).toHaveLength(0);
  });

  it("both: names BOTH malformed seeds, not just the first", async () => {
    const { deps, messages } = scriptedDeps([]);

    const write = await collectCredentials(
      "both",
      deps,
      {},
      { ownerAddress: MALFORMED_ADDRESS, keyAdminAddress: SHORT_HEX_ADDRESS },
    );

    expect(isEmptyWrite(write)).toBe(true);
    const failures = messages.filter((m) => m.startsWith("fail:"));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("--owner-address");
    expect(failures[1]).toContain("--key-admin-address");
  });

  // An empty seed is not an absent one. This path writes the seed verbatim, so
  // it would save `webAccountAddress: ""` — dropped on the next read, leaving a
  // host the installer called configured and `create_bucket` refuses. (The
  // bundle path normalizes instead, which is worse still: see the zero-address
  // test in `validateSilent — credential bundle`.) The confirm is answered "y"
  // so that a missing guard really would reach the write.
  it("refuses an empty owner seed instead of writing it", async () => {
    const { deps, messages } = scriptedDeps(["hbr_working_key_value", VALID_SIGNER, "y"]);

    const write = await collectCredentials("api", deps, {}, { ownerAddress: "" });

    expect(isEmptyWrite(write)).toBe(true);
    expect(write.updates.webAccountAddress).toBeUndefined();
    const failures = messages.filter((m) => m.startsWith("fail:"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("--owner-address");
  });

  it("refuses an empty seed on the bundle choice too", async () => {
    const { deps, asked } = scriptedDeps([adminBundleJson(), "y"]);

    const write = await collectCredentials("bundle", deps, {}, { keyAdminAddress: "" });

    expect(isEmptyWrite(write)).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

describe("collectCredentials — manual address pins", () => {
  const API_ANSWERS = ["hbr_working_key_value", VALID_SIGNER];

  it("persists each address only after its own confirmation", async () => {
    const { deps, asked, messages } = scriptedDeps([
      ...API_ANSWERS,
      OWNER_ADDRESS,
      "y",
      KEY_ADMIN_ADDRESS,
      "y",
    ]);

    const { updates, clear } = await collectCredentials("api", deps);

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(updates.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
    expect(clear).toEqual([]);
    // The unmasked input row is the re-read; a second `show` of the same value
    // is what printed the address twice in the AUTHENTICATE panel. `show` is
    // reserved for a saved pin / bundle the operator did not just type.
    expect(messages).not.toContain(`show:${OWNER_ADDRESS}`);
    expect(messages).not.toContain(`show:${KEY_ADMIN_ADDRESS}`);
    expect(asked[3]).toMatch(/\[y\/N\]/);
    expect(asked[3]).not.toContain(OWNER_ADDRESS);
    expect(asked[5]).toMatch(/\[y\/N\]/);
    expect(asked[5]).not.toContain(KEY_ADMIN_ADDRESS);
    // The input row is just the gutter (empty question): a 66-char address
    // plus a long "Bucket owner Sui address…" label cannot share a line.
    expect(asked[2]).toBe("");
    expect(messages.some((m) => m.startsWith("info:") && /Sui address/i.test(m))).toBe(true);
  });

  it("writes nothing for an address whose confirmation is declined", async () => {
    // Declined → re-prompt → bare Enter skips it.
    const { deps } = scriptedDeps([...API_ANSWERS, OWNER_ADDRESS, "n", "", ""]);

    const { updates, clear } = await collectCredentials("api", deps);

    expect(updates.webAccountAddress).toBeUndefined();
    expect(clear).toEqual([]);
  });

  it("skips on a bare Enter and warns that create_bucket will refuse", async () => {
    const { deps, messages } = scriptedDeps([...API_ANSWERS, "", ""]);

    const { updates } = await collectCredentials("api", deps);

    expect(updates.webAccountAddress).toBeUndefined();
    expect(messages.some((m) => m.startsWith("warn:") && m.includes("create_bucket"))).toBe(true);
  });

  it("re-prompts on a malformed address without echoing it", async () => {
    const junk = "0xNOT_AN_ADDRESS_VALUE";
    const { deps, messages } = scriptedDeps([...API_ANSWERS, junk, OWNER_ADDRESS, "y", ""]);

    const { updates } = await collectCredentials("api", deps);

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(messages.some((m) => m.startsWith("fail:"))).toBe(true);
    expect(messages.join("\n")).not.toContain(junk);
  });

  // The asymmetry with the bundle path: manual entry MERGES, so skipping a
  // prompt leaves whatever is already saved alone.
  it("preserves saved pins when both prompts are skipped", async () => {
    const { deps } = scriptedDeps([...API_ANSWERS, "", ""]);

    const { updates, clear } = await collectCredentials("api", deps, {
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });

    expect(clear).not.toContain("webAccountAddress");
    expect(clear).not.toContain("keyAdminAddress");
    expect(updates.webAccountAddress).toBeUndefined();
    expect(updates.keyAdminAddress).toBeUndefined();
  });

  // Skipping is only a refusal-in-waiting when nothing is pinned. Warning about
  // it while a perfectly good pin sits in the file sends the operator hunting for
  // a problem they do not have.
  it("reports what it is keeping instead of warning when a pin is already saved", async () => {
    const { deps, messages } = scriptedDeps([...API_ANSWERS, "", ""]);

    await collectCredentials("api", deps, { webAccountAddress: OWNER_ADDRESS });

    expect(messages.some((m) => m.startsWith("warn:") && m.includes("create_bucket"))).toBe(false);
    expect(messages).toContain(`show:${OWNER_ADDRESS}`);
    // ...and the copy says Enter keeps it, rather than "skip". The wording
    // lives on an info line so the input row can hold the 66-char address.
    expect(messages.join("\n")).toMatch(/keep/i);
  });

  it("still warns for the pin that is NOT saved", async () => {
    const { deps, messages } = scriptedDeps([...API_ANSWERS, "", ""]);

    await collectCredentials("api", deps, { keyAdminAddress: KEY_ADMIN_ADDRESS });

    expect(messages.some((m) => m.startsWith("warn:") && m.includes("create_bucket"))).toBe(true);
  });

  it("asks for the addresses unmasked — they are not secrets", async () => {
    const { deps, askedMasked } = scriptedDeps([...API_ANSWERS, "", ""]);

    await collectCredentials("api", deps);

    expect(askedMasked[2]).toBe(false);
    expect(askedMasked[3]).toBe(false);
  });

  it("asks for the pins on the 'both' flow without disturbing the credential order", async () => {
    const { deps, asked } = scriptedDeps([
      "hbr_working_key_value",
      VALID_SIGNER,
      "hbradm_management_key",
      VALID_SIGNER_2,
      OWNER_ADDRESS,
      "y",
      "",
    ]);

    const { updates } = await collectCredentials("both", deps);

    expect(asked[0]).toContain("CONSOLE_API_KEY");
    expect(asked[2]).toContain("CONSOLE_ADMIN_KEY");
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("admin: derives keyAdminAddress from the pasted signer and shows it", async () => {
    const { deps, messages } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER]);
    const { updates } = await collectCredentials("admin", deps);
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    expect(updates.keyAdminAddress).toBe(derived);
    expect(updates.adminServicePrivateKey).toBe(VALID_SIGNER);
    expect(messages).toContain(`show:${derived}`);
  });

  it("admin: a new signer overwrites a previously saved Key-Admin pin (rotation)", async () => {
    const { deps } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER_2]);
    const { updates } = await collectCredentials("admin", deps, {
      keyAdminAddress: STALE_ADDRESS,
    });
    expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER_2));
  });

  it("api: an owner seed skips the owner prompt, shows the address, confirms once, and persists it", async () => {
    const { deps, messages } = scriptedDeps(["hbr_working_key_value", "", "y"]);

    const { updates } = await collectCredentials("api", deps, {}, { ownerAddress: OWNER_ADDRESS });

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(messages).toContain(`show:${OWNER_ADDRESS}`);
    // The owner prompt's copy goes out through `info`; it must not appear.
    expect(messages.some((m) => m.includes("Bucket owner Sui address"))).toBe(false);
    // Key-Admin was not seeded, so its prompt still ran (and was skipped by the empty answer).
    expect(messages.some((m) => m.includes("Key-Admin Sui address"))).toBe(true);
  });

  it("api: declining the seeded pins writes nothing, not even the verified key", async () => {
    const { deps } = scriptedDeps(["hbr_working_key_value", "", "n"]);

    const write = await collectCredentials("api", deps, {}, { ownerAddress: OWNER_ADDRESS });

    expect(isEmptyWrite(write)).toBe(true);
  });

  it("api: both seeds are shown and confirmed together, and no pin prompt runs", async () => {
    const { deps, messages } = scriptedDeps(["hbr_working_key_value", "", "y"]);

    const { updates } = await collectCredentials(
      "api",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS },
    );

    expect(updates).toMatchObject({
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
    expect(messages).toContain(`show:${OWNER_ADDRESS}`);
    expect(messages).toContain(`show:${KEY_ADMIN_ADDRESS}`);
    expect(messages.some((m) => m.includes("Sui address ("))).toBe(false);
  });

  it("admin: a Key-Admin seed equal to the derived address persists once, without a seed confirm", async () => {
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const { deps, asked } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER]);

    const { updates } = await collectCredentials("admin", deps, {}, { keyAdminAddress: derived });

    expect(updates.keyAdminAddress).toBe(derived);
    expect(asked.some((q) => q.includes("Pin these addresses"))).toBe(false);
  });

  it("admin: a Key-Admin seed that disagrees with the derived address refuses and writes nothing", async () => {
    const { deps, messages } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER]);

    const write = await collectCredentials("admin", deps, {}, { keyAdminAddress: STALE_ADDRESS });

    expect(isEmptyWrite(write)).toBe(true);
    const failure = messages.find((m) => m.startsWith("fail:"));
    expect(failure).toContain(STALE_ADDRESS);
    expect(failure).toContain(suiAddressFromServiceKey(VALID_SIGNER));
  });

  // The prompt below is gated on api/both because a provisioning-only host never
  // calls `create_bucket`, so there is nothing to ask about. A FLAG is not that:
  // the operator typed this address, and a management-only host can later gain a
  // working key. Dropping an explicit instruction with no message is worse than
  // saving a pin that may sit unused, so the seed has no kind gate.
  it("admin: an owner seed on a management-only host is shown, confirmed and persisted", async () => {
    const { deps, messages } = scriptedDeps(["hbradm_management_key_value", VALID_SIGNER, "y"]);

    const { updates } = await collectCredentials(
      "admin",
      deps,
      {},
      { ownerAddress: OWNER_ADDRESS },
    );

    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(messages).toContain(`show:${OWNER_ADDRESS}`);
  });

  it("does not ask for pins on the management-only flow", async () => {
    const { deps, asked } = scriptedDeps(["hbradm_management_key", VALID_SIGNER]);

    await collectCredentials("admin", deps);

    expect(asked.some((q) => /Sui address/i.test(q))).toBe(false);
  });
});

describe("validateSilent", () => {
  const okProbe = async () => "ok" as const;

  it("accepts a complete management pair", async () => {
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: VALID_SIGNER },
      okProbe,
    );
    expect(errors).toEqual([]);
    expect(updates).toEqual({
      adminKey: "hbradm_x_value",
      adminServicePrivateKey: VALID_SIGNER,
      keyAdminAddress: suiAddressFromServiceKey(VALID_SIGNER),
    });
  });

  it("derives keyAdminAddress from --admin-signer", async () => {
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: VALID_SIGNER },
      okProbe,
      {},
      NO_ENV,
    );
    expect(errors).toEqual([]);
    expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));
  });

  // "Rotating the management key is the one overwrite" — but no silent flag-path
  // test started from a non-empty config: every derivation test starts from `{}`,
  // and the only saved-stale case goes through a bundle.
  //
  // Asserted at the CONFIG FILE, not on `updates`. Nothing on the flag path
  // reads `existing` (`pinSurvives` is bundle-only), so a `{ keyAdminAddress:
  // STALE_ADDRESS }` argument alone is inert — the test would stay green with
  // `{}` and prove nothing the plain derivation test does not. The overwrite
  // actually happens in `mergeConfigFile`, so that is where it is checked: save
  // a stale pin, rotate the signer, merge, read back.
  it("a new --admin-signer overwrites a saved stale Key-Admin pin in the config file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-admin-rotate-"));
    const originalEnv = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    try {
      // The host as the OLD management key left it.
      saveConfigFile({
        adminKey: "hbradm_old_key_value",
        adminServicePrivateKey: VALID_SIGNER_2,
        keyAdminAddress: STALE_ADDRESS,
      });
      const existing = loadConfigFile();
      expect(existing.keyAdminAddress).toBe(STALE_ADDRESS);

      const { updates, clear, errors, warnings } = await validateSilent(
        { adminKey: "hbradm_new_key_value", adminSigner: VALID_SIGNER },
        okProbe,
        existing,
        NO_ENV,
      );

      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      // The saved pin belonged to the OLD signer, so the derivation replaces it
      // rather than being refused against it.
      expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));
      expect(clear).not.toContain("keyAdminAddress");

      const merged = mergeConfigFile(updates, clear);
      expect(merged.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));

      // Read back from disk: the stale pin is gone, and the new one is a real
      // address, so `loadConfigFile`'s own `isValidSuiAddress` re-check keeps it
      // instead of silently dropping it.
      const reloaded = loadConfigFile();
      expect(reloaded.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));
      expect(reloaded.keyAdminAddress).not.toBe(STALE_ADDRESS);
      expect(reloaded.adminServicePrivateKey).toBe(VALID_SIGNER);
    } finally {
      process.env = originalEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses when --key-admin-address disagrees with the derived address", async () => {
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: VALID_SIGNER, keyAdminAddress: STALE_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(suiAddressFromServiceKey(VALID_SIGNER));
    expect(Object.keys(updates)).toHaveLength(0);
  });

  it("persists an equal --key-admin-address once", async () => {
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: VALID_SIGNER, keyAdminAddress: derived },
      okProbe,
      {},
      NO_ENV,
    );
    expect(errors).toEqual([]);
    expect(updates.keyAdminAddress).toBe(derived);
  });

  // The end-to-end guarantee behind the classifyProbe fix: an upstream failure
  // must not persist a credential it never actually verified.
  it("writes nothing when the probe cannot reach a verdict", async () => {
    const unreachable = async () => "unreachable" as const;
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: VALID_SIGNER },
      unreachable,
    );
    expect(updates.adminKey).toBeUndefined();
    expect(updates.adminServicePrivateKey).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("writes nothing for a working key when the probe cannot reach a verdict", async () => {
    const { updates, errors } = await validateSilent(
      { apiKey: "hbr_x_value" },
      async () => "unreachable" as const,
    );
    expect(updates.apiKey).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects half a management credential and writes nothing", async () => {
    const { updates, errors } = await validateSilent({ adminKey: "hbradm_x_value" }, okProbe);
    expect(updates).toEqual({});
    expect(errors[0]).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
  });

  it("rejects a wrong-type key without probing", async () => {
    let probed = false;
    const { errors } = await validateSilent({ adminKey: "hbr_wrong_type" }, async () => {
      probed = true;
      return "ok" as const;
    });
    expect(probed).toBe(false);
    expect(errors[0]).toContain("everyday API key");
  });

  it("reports nothing to do when no values are supplied", async () => {
    const { errors } = await validateSilent({}, okProbe);
    expect(errors[0]).toContain("No credentials given");
  });

  // The advice has to be followable. `CONSOLE_*` was not: the installer folds
  // exactly five variables into `values` (`ENV_FLAGS`, src/cliArgs.ts:86-97),
  // and the two the reveal displays — CONSOLE_WEB_ACCOUNT_ADDRESS /
  // CONSOLE_KEY_ADMIN_ADDRESS — are deliberately absent, because the SERVER
  // reads those at runtime and the installer must not persist them. An operator
  // who exported one and re-ran with --silent landed on this same error.
  it("names only environment variables the CLI actually reads", async () => {
    const { errors } = await validateSilent({}, okProbe, {}, NO_ENV);
    const message = errors[0] ?? "";
    const named = [...message.matchAll(/CONSOLE_[A-Z_]+/g)].map(([name]) => name);

    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      // `--silent` is the mode the message describes, so this is the exact read
      // the advice promises. A variable that survives into `values` is honoured;
      // anything else sends the operator straight back to this error.
      expect({ name, read: envVarIsRead(name) }).toEqual({ name, read: true });
    }

    // The two the server reads and the installer refuses to persist.
    expect(message).not.toContain("CONSOLE_WEB_ACCOUNT_ADDRESS");
    expect(message).not.toContain("CONSOLE_KEY_ADMIN_ADDRESS");
  });

  // The CONVERSE direction. Promising a variable the CLI ignores and omitting
  // one it reads are the same defect, and only the first was covered — which is
  // how CONSOLE_MCP_ALLOWED_DIRS (folded in by `parseArgs` via
  // `ALLOWED_DIRS_ENV`, and enough on its own to get past this error) went
  // missing from the first version of the list. Candidates come from the modules
  // that own them, not from a list hand-copied into this test.
  it("names every environment variable it does read, and only those", async () => {
    const { errors } = await validateSilent({}, okProbe, {}, NO_ENV);
    const message = errors[0] ?? "";

    const candidates = [
      ...SECRET_ENV_VARS,
      ALLOWED_DIRS_ENV,
      // Read by the SERVER at runtime (src/config.ts), never by the installer —
      // so these must stay absent, and the biconditional below says so.
      "CONSOLE_WEB_ACCOUNT_ADDRESS",
      "CONSOLE_KEY_ADMIN_ADDRESS",
    ];

    for (const name of candidates) {
      expect({ name, named: message.includes(name) }).toEqual({
        name,
        named: envVarIsRead(name),
      });
    }
  });

  it("offers the address pins by their flag spelling, which is the only one", async () => {
    const { errors } = await validateSilent({}, okProbe, {}, NO_ENV);
    const message = errors[0] ?? "";

    expect(message).toContain("--owner-address");
    expect(message).toContain("--key-admin-address");
  });

  describe("allowed dirs", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-silent-dirs-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts --allowed-dirs alone and writes no credentials", async () => {
      const { updates, errors } = await validateSilent({ allowedDirs: [dir] }, okProbe);
      expect(errors).toEqual([]);
      expect(updates.apiKey).toBeUndefined();
      expect(updates.allowedDirs).toEqual([toRealPath(dir)]);
    });

    it("writes allowedDirs alongside an API key", async () => {
      const { updates, errors } = await validateSilent(
        { apiKey: "hbr_x_value", allowedDirs: [dir] },
        okProbe,
      );
      expect(errors).toEqual([]);
      expect(updates.apiKey).toBe("hbr_x_value");
      expect(updates.allowedDirs).toEqual([toRealPath(dir)]);
    });

    it("rejects a missing directory and writes nothing", async () => {
      const { updates, errors } = await validateSilent(
        { allowedDirs: [path.join(dir, "missing")] },
        okProbe,
      );
      expect(updates).toEqual({});
      expect(errors[0]).toContain("--allowed-dirs");
      expect(errors[0]).toMatch(/does not exist/);
    });
  });

  it("accepts a real generated working-key signer", async () => {
    const { updates, errors } = await validateSilent({ serviceKey: VALID_SIGNER }, okProbe);
    expect(errors).toEqual([]);
    expect(updates).toEqual({ servicePrivateKey: VALID_SIGNER });
  });

  it("rejects a garbled working-key signer with an exit-shaped error and writes nothing", async () => {
    const { updates, errors } = await validateSilent({ serviceKey: GARBLED_SIGNER }, okProbe);
    expect(updates).toEqual({});
    expect(errors[0]).toContain("--service-key");
    // The bad value itself must never appear in the error.
    expect(errors.join(" ")).not.toContain(GARBLED_SIGNER);
  });

  it("rejects a garbled admin signer with an exit-shaped error and writes nothing", async () => {
    const { updates, errors } = await validateSilent(
      { adminKey: "hbradm_x_value", adminSigner: GARBLED_SIGNER },
      okProbe,
    );
    expect(updates).toEqual({});
    expect(errors[0]).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
    expect(errors.join(" ")).not.toContain(GARBLED_SIGNER);
  });
});

describe("validateSilent — credential bundle", () => {
  const okProbe = async () => "ok" as const;

  it("maps an admin bundle to the management pair and derived pin", async () => {
    const adminKey = "hbradm_management_key_value";
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const { updates, errors } = await validateSilent(
      {
        bundle: JSON.stringify({
          v: 1,
          adminKey,
          adminServicePrivateKey: VALID_SIGNER,
          ownerAddress: OWNER_ADDRESS,
          keyAdminAddress: derived,
        }),
      },
      okProbe,
    );
    expect(errors).toEqual([]);
    expect(updates).toEqual({
      adminKey,
      adminServicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: derived,
    });
  });

  it("an admin bundle derives and refuses on disagreement", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ keyAdminAddress: STALE_ADDRESS }) },
      okProbe,
      {},
      NO_ENV,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(suiAddressFromServiceKey(VALID_SIGNER));
    expect(Object.keys(updates)).toHaveLength(0);
  });

  it("an admin bundle with a null Key-Admin persists the derived pin instead of clearing it", async () => {
    const { updates, clear, errors } = await validateSilent(
      { bundle: adminBundleJson({ keyAdminAddress: null }) },
      okProbe,
      { keyAdminAddress: STALE_ADDRESS },
      NO_ENV,
    );
    expect(errors).toEqual([]);
    expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER));
    expect(clear).not.toContain("keyAdminAddress");
  });

  it("maps a bundle to all four fields", async () => {
    const { updates, clear, errors } = await validateSilent({ bundle: bundleJson() }, okProbe);

    expect(errors).toEqual([]);
    expect(updates).toEqual({
      apiKey: BUNDLE_API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
    expect(clear).toEqual([]);
  });

  it("clears a stale pin the bundle carries as null", async () => {
    const { updates, clear, errors } = await validateSilent(
      { bundle: bundleJson({ webAccountAddress: null }) },
      okProbe,
      { webAccountAddress: STALE_ADDRESS },
    );

    expect(errors).toEqual([]);
    expect(updates.webAccountAddress).toBeUndefined();
    expect(clear).toContain("webAccountAddress");
  });

  // The verbatim shape the Console's `buildCredentialBundle` emits for a
  // working-key reveal — alias spellings for BOTH fields — on an account with no
  // owner. Every other flow test uses the canonical spellings, and the alias is
  // parsed exactly once and non-null, so the alias-null path had no coverage.
  it("clears a saved owner pin and warns for a Console reveal whose ownerAddress is null", async () => {
    const { updates, clear, errors, warnings } = await validateSilent(
      {
        bundle: JSON.stringify({
          v: 1,
          apiKey: BUNDLE_API_KEY,
          serviceSecret: VALID_SIGNER,
          ownerAddress: null,
          keyAdminAddress: KEY_ADMIN_ADDRESS,
        }),
      },
      okProbe,
      { webAccountAddress: STALE_ADDRESS },
      NO_ENV,
    );

    expect(errors).toEqual([]);
    // The alias carried the signer through, so this really is the working pair.
    expect(updates.apiKey).toBe(BUNDLE_API_KEY);
    expect(updates.servicePrivateKey).toBe(VALID_SIGNER);
    // A WORKING bundle is authoritative: its null owner clears the stale pin...
    expect(updates.webAccountAddress).toBeUndefined();
    expect(clear).toContain("webAccountAddress");
    // ...and the host is then one that would refuse every create_bucket.
    expect(warnings).toEqual([NO_OWNER_PIN_WARNING]);
  });

  // The ABSENT-field case, as opposed to an explicit null. `pickOwnerAddress`
  // returns the same `null` for both, and a working bundle's null is the
  // account's own answer, so omitting the field must clear exactly as null does.
  // Only admin bundles exercised the absent-field path before.
  it("clears a saved owner pin when a working bundle omits the owner entirely", async () => {
    const raw = bundleJson({ webAccountAddress: undefined });
    // Guard the fixture: JSON.stringify must have dropped the key, not nulled it.
    expect(raw).not.toContain("webAccountAddress");
    expect(raw).not.toContain("ownerAddress");

    const { updates, clear, errors, warnings } = await validateSilent(
      { bundle: raw },
      okProbe,
      { webAccountAddress: STALE_ADDRESS },
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.webAccountAddress).toBeUndefined();
    expect(clear).toContain("webAccountAddress");
    expect(warnings).toEqual([NO_OWNER_PIN_WARNING]);
  });

  it("clears BOTH stale pins when the bundle carries both as null", async () => {
    const { updates, clear, errors } = await validateSilent(
      { bundle: bundleJson({ webAccountAddress: null, keyAdminAddress: null }) },
      okProbe,
      { webAccountAddress: STALE_ADDRESS, keyAdminAddress: STALE_ADDRESS },
    );

    expect(errors).toEqual([]);
    expect(updates).toEqual({ apiKey: BUNDLE_API_KEY, servicePrivateKey: VALID_SIGNER });
    expect(clear).toEqual(["webAccountAddress", "keyAdminAddress"]);
  });

  // A scripted install must not silently produce a config where every
  // create_bucket refuses. --silent has no prompt to warn on, so the warning
  // rides back on the result and the entry points print it.
  it("returns the owner warning when the bundle carries a null owner", async () => {
    const { warnings, errors } = await validateSilent(
      { bundle: bundleJson({ webAccountAddress: null }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("create_bucket");
    expect(warnings.join(" ")).toContain("CONSOLE_WEB_ACCOUNT_ADDRESS");
    // Word for word what the interactive path says — one message, not two dialects.
    expect(warnings).toEqual([NO_OWNER_PIN_WARNING]);
  });

  it("returns both warnings when the bundle carries neither address", async () => {
    const { warnings } = await validateSilent(
      { bundle: bundleJson({ webAccountAddress: null, keyAdminAddress: null }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(warnings).toEqual([NO_OWNER_PIN_WARNING, NO_KEY_ADMIN_PIN_WARNING]);
  });

  it("returns no warnings for a complete bundle", async () => {
    const { warnings } = await validateSilent({ bundle: bundleJson() }, okProbe, {}, NO_ENV);
    expect(warnings).toEqual([]);
  });

  it("returns no warnings when nothing was written", async () => {
    const { warnings, errors } = await validateSilent({ bundle: "not json" }, okProbe, {}, NO_ENV);
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  it("refuses a bundle combined with an individual credential flag", async () => {
    const { updates, clear, errors } = await validateSilent(
      { bundle: bundleJson(), apiKey: "hbr_some_other_key" },
      okProbe,
      {},
      NO_ENV,
    );

    expect(updates).toEqual({});
    expect(clear).toEqual([]);
    expect(errors.join(" ")).toContain("--credential-bundle");
    // Nothing in the environment supplied it, so the message must not send the
    // operator hunting for a variable they never exported.
    expect(errors.join(" ")).not.toContain("CONSOLE_CREDENTIAL_BUNDLE");
  });

  // An address flag beside a bundle is not a conflict but a second statement of
  // the same pin: equal proceeds, different refuses and names both.
  it("accepts a bundle next to an equal --owner-address", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson(), ownerAddress: OWNER_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("refuses a bundle next to a different --owner-address, naming both", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson(), ownerAddress: STALE_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(OWNER_ADDRESS);
    expect(updates).toEqual({});
  });

  it("refuses a --key-admin-address where the bundle says null", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson({ keyAdminAddress: null }), keyAdminAddress: KEY_ADMIN_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no such address");
    expect(updates).toEqual({});
  });

  it("refuses an admin bundle combined with --admin-key", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson(), adminKey: "hbradm_other_value", adminSigner: VALID_SIGNER_2 },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors.some((e) => e.includes("--admin-key"))).toBe(true);
    expect(updates).toEqual({});
  });

  it("composes an admin bundle with --api-key / --service-key", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson(), apiKey: "hbr_working_key_value", serviceKey: VALID_SIGNER_2 },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates).toMatchObject({
      adminKey: "hbradm_management_key_value",
      adminServicePrivateKey: VALID_SIGNER,
      apiKey: "hbr_working_key_value",
      servicePrivateKey: VALID_SIGNER_2,
    });
  });

  it("names the environment variable when the bundle came from CONSOLE_CREDENTIAL_BUNDLE", async () => {
    // `parseArgs` folds CONSOLE_CREDENTIAL_BUNDLE into this field whenever
    // --silent is in effect, so an operator who exported it at install time and
    // later runs `config --api-key hbr_… --silent` to swap keys lands here having
    // passed no --credential-bundle at all. Naming that flag sends them searching
    // their own command line for it; the fix is to unset the variable, so the
    // message has to say which variable and what to do with it.
    const bundle = bundleJson();
    const { updates, errors } = await validateSilent(
      { bundle, apiKey: "hbr_some_other_key" },
      okProbe,
      {},
      { CONSOLE_CREDENTIAL_BUNDLE: bundle },
    );

    expect(updates).toEqual({});
    expect(errors.join(" ")).toContain("CONSOLE_CREDENTIAL_BUNDLE");
    expect(errors.join(" ")).toMatch(/unset/i);
    expect(errors.join(" ")).toContain("--api-key");
    // Never the bundle itself: it is a live credential.
    expect(errors.join(" ")).not.toContain(BUNDLE_API_KEY);
  });

  // The management pair is a different credential slot, so it composes with the
  // bundle rather than conflicting with it. Silently dropping it — the shape the
  // early return had — would be the worst of the three options.
  // The composition above is the one place two sources name the Key-Admin without
  // either being a flag: the bundle carries a pin, and the admin signer derives
  // one. Silently preferring the derivation is exactly the swap the pins exist to
  // catch, so it refuses like every other disagreement.
  it("refuses when a bundle's Key-Admin disagrees with the --admin-signer's derived address", async () => {
    const { updates, errors } = await validateSilent(
      {
        bundle: bundleJson({ keyAdminAddress: STALE_ADDRESS }),
        adminKey: "hbradm_management_key",
        adminSigner: VALID_SIGNER_2,
      },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(suiAddressFromServiceKey(VALID_SIGNER_2));
    expect(updates).toEqual({});
  });

  // `mergeConfigFile` applies `clear` after `updates`, so a queued clear would
  // delete the pin this write just derived — the returned `updates` would claim a
  // pin that never reached the disk. The warning has the same failure mode one
  // step later: it is queued from the bundle and describes a config that no
  // longer exists by the time the admin block has run.
  it("does not clear or warn about the Key-Admin the admin pair derives when the bundle carries null", async () => {
    const { updates, clear, errors, warnings } = await validateSilent(
      {
        bundle: bundleJson({ keyAdminAddress: null }),
        adminKey: "hbradm_management_key",
        adminSigner: VALID_SIGNER_2,
      },
      okProbe,
      { keyAdminAddress: STALE_ADDRESS },
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.keyAdminAddress).toBe(suiAddressFromServiceKey(VALID_SIGNER_2));
    expect(clear).not.toContain("keyAdminAddress");
    expect(warnings).not.toContain(NO_KEY_ADMIN_PIN_WARNING);
  });

  // The split-credential host the kind-aware composition rule exists to support:
  // a management bundle for provisioning, working flags for everyday use. The
  // management bundle says nothing about the owner, so the saved pin must live.
  it("an admin bundle carrying no owner does not clear the saved owner pin or warn about it", async () => {
    const { updates, clear, errors, warnings } = await validateSilent(
      {
        bundle: adminBundleJson({ ownerAddress: undefined }),
        apiKey: "hbr_working_key_value",
        serviceKey: VALID_SIGNER_2,
      },
      okProbe,
      { webAccountAddress: OWNER_ADDRESS },
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(clear).not.toContain("webAccountAddress");
    expect(updates.webAccountAddress).toBeUndefined();
    expect(warnings).not.toContain(NO_OWNER_PIN_WARNING);
  });

  it("accepts a --key-admin-address equal to what an admin bundle's own signer derives", async () => {
    const derived = suiAddressFromServiceKey(VALID_SIGNER);
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ keyAdminAddress: null }), keyAdminAddress: derived },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.keyAdminAddress).toBe(derived);
  });

  it("refuses a --key-admin-address that differs from what an admin bundle derives", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ keyAdminAddress: null }), keyAdminAddress: STALE_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(suiAddressFromServiceKey(VALID_SIGNER));
    expect(updates).toEqual({});
  });

  // The bundle branch is the one `--owner-address` route that never reached
  // `validateAddressFlag`, and C1 made that seed something the write PERSISTS.
  // `parseArgs` guards the real CLI, but `validateSilent` is a public entry
  // point and must not depend on its caller having validated.
  it("refuses a malformed --owner-address beside an admin bundle instead of writing it", async () => {
    const { updates, clear, errors } = await validateSilent(
      {
        bundle: adminBundleJson({ ownerAddress: undefined }),
        ownerAddress: MALFORMED_ADDRESS,
      },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--owner-address");
    expect(errors[0]).toContain("not a valid Sui address");
    expect(errors[0]).not.toContain(MALFORMED_ADDRESS);
    expect(updates).toEqual({});
    expect(clear).toEqual([]);
  });

  it("refuses a short-hex --owner-address rather than zero-padding it into the config", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ ownerAddress: undefined }), ownerAddress: SHORT_HEX_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(updates.webAccountAddress).toBeUndefined();
  });

  it("refuses a malformed --key-admin-address beside a bundle", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson(), keyAdminAddress: MALFORMED_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--key-admin-address");
    expect(errors[0]).not.toContain(MALFORMED_ADDRESS);
    expect(updates).toEqual({});
  });

  // The non-bundle branch reports every malformed flag; the bundle branch used a
  // `??` chain and stopped at the first. This PR's idiom is naming BOTH.
  it("reports BOTH malformed seeds beside a bundle, like the non-bundle branch", async () => {
    const { updates, errors } = await validateSilent(
      {
        bundle: adminBundleJson(),
        ownerAddress: MALFORMED_ADDRESS,
        keyAdminAddress: SHORT_HEX_ADDRESS,
      },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("--owner-address");
    expect(errors[1]).toContain("--key-admin-address");
    expect(updates).toEqual({});
  });

  it("refuses an empty --owner-address rather than pinning the zero address", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ ownerAddress: undefined }), ownerAddress: "" },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--owner-address");
    expect(updates.webAccountAddress).toBeUndefined();
    // The zero address is a VALID Sui address, so nothing downstream would have
    // rejected it — that is what makes the empty seed worse than a junk one.
    expect(updates.webAccountAddress).not.toBe(ZERO_ADDRESS);
  });

  // A malformed seed must be refused before the probe: a bundle we are going to
  // reject should cost no round trip.
  it("does not probe when the seed beside the bundle is malformed", async () => {
    let probed = false;
    const { errors } = await validateSilent(
      { bundle: adminBundleJson(), ownerAddress: MALFORMED_ADDRESS },
      async () => {
        probed = true;
        return "ok" as const;
      },
      {},
      NO_ENV,
    );

    expect(probed).toBe(false);
    expect(errors).toHaveLength(1);
  });

  // The silent half of the owner-seed rule. `bundleWrite` is where the seed is
  // applied, so both callers get it from one place — this asserts the second one.
  it("an --owner-address fills the owner an admin bundle does not carry", async () => {
    const { updates, clear, errors, warnings } = await validateSilent(
      { bundle: adminBundleJson({ ownerAddress: undefined }), ownerAddress: OWNER_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
    expect(clear).not.toContain("webAccountAddress");
    // Resolved by the write, so there is no missing pin to warn about.
    expect(warnings).not.toContain(NO_OWNER_PIN_WARNING);
  });

  it("an --owner-address fills an admin bundle's explicit null owner", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ ownerAddress: null }), ownerAddress: OWNER_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("refuses an --owner-address that differs from the owner an admin bundle carries", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson(), ownerAddress: STALE_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(STALE_ADDRESS);
    expect(errors[0]).toContain(OWNER_ADDRESS);
    expect(updates).toEqual({});
  });

  // A working bundle is authoritative for the owner, so its `null` still
  // contradicts a seed. Only the management-bundle case was relaxed.
  it("refuses an --owner-address where a working bundle says null", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson({ webAccountAddress: null }), ownerAddress: OWNER_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(OWNER_ADDRESS);
    expect(errors[0]).toContain("no such address");
    expect(updates).toEqual({});
  });

  it("refuses an apiKey holding an hbradm_ value without echoing it", async () => {
    const badKey = "hbradm_in_the_wrong_field_value";
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson({ apiKey: badKey }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.toLowerCase()).toContain("management");
    expect(errors[0]).not.toContain(badKey);
    expect(updates).toEqual({});
  });

  it("configures the management pair alongside a bundle", async () => {
    const derivedAdmin = suiAddressFromServiceKey(VALID_SIGNER_2);
    const { updates, errors } = await validateSilent(
      {
        bundle: bundleJson({ keyAdminAddress: derivedAdmin }),
        adminKey: "hbradm_management_key",
        adminSigner: VALID_SIGNER_2,
      },
      okProbe,
    );

    expect(errors).toEqual([]);
    expect(updates).toEqual({
      apiKey: BUNDLE_API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: derivedAdmin,
      adminKey: "hbradm_management_key",
      adminServicePrivateKey: VALID_SIGNER_2,
    });
  });

  it("writes nothing at all when the bundle is fine but the management pair is half-given", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson(), adminKey: "hbradm_management_key" },
      okProbe,
    );

    expect(updates).toEqual({});
    expect(errors.join(" ")).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
  });

  it("rejects a malformed bundle, writes nothing, and never echoes it", async () => {
    const junk = '{"v":1,"apiKey":"hbr_x","serviceSecret":"NEVER_ECHO_THIS_VALUE"}';
    const { updates, errors } = await validateSilent({ bundle: junk }, okProbe);

    expect(updates).toEqual({});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).not.toContain("NEVER_ECHO_THIS_VALUE");
    expect(errors.join(" ")).not.toContain(junk);
  });

  it("writes nothing when the bundle's key cannot be verified", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson() },
      async () => "unreachable" as const,
    );

    expect(updates).toEqual({});
    expect(errors.length).toBeGreaterThan(0);
  });
});

// A pasted `config.json` can hold BOTH credential pairs, and `apiKey` is tested
// first, so the parse narrows to `kind: "api"` and throws the management pair
// away before `registerBundleSecrets` ever sees it. Registering the bundle
// STRING does not cover the values inside it (`src/redaction.ts:34-38` says so),
// so those two secrets used to reach the probe unregistered. Defense in depth —
// no current path echoes them — but the probe's fetch error is exactly the kind
// of string that would.
describe("bundle secret registration — the pair the parse discards", () => {
  const okProbe = async () => "ok" as const;
  /** Dedicated to this block so registering it cannot affect any other test. */
  const OTHER_PAIR_SIGNER = Ed25519Keypair.generate().getSecretKey();
  /** A second one, for the case where a paste carries BOTH signer spellings. */
  const SECOND_SPELLING_SIGNER = Ed25519Keypair.generate().getSecretKey();

  beforeEach(clearSecrets);
  afterEach(clearSecrets);

  it("registers the management pair a working bundle also carries", async () => {
    const otherAdminKey = "hbradm_other_pair_key_value";

    const { updates, errors } = await validateSilent(
      {
        bundle: bundleJson({ adminKey: otherAdminKey, adminServicePrivateKey: OTHER_PAIR_SIGNER }),
      },
      okProbe,
      {},
      NO_ENV,
    );

    // The parse kept the working pair and dropped the management one...
    expect(errors).toEqual([]);
    expect(updates.adminKey).toBeUndefined();
    // ...but redaction still knows both discarded values.
    expect(redactString(`Authorization: Bearer ${otherAdminKey}`)).not.toContain(otherAdminKey);
    expect(redactString(`signer=${OTHER_PAIR_SIGNER}`)).not.toContain(OTHER_PAIR_SIGNER);
  });

  it("registers the working signer an admin bundle also carries", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: adminBundleJson({ servicePrivateKey: OTHER_PAIR_SIGNER }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(updates.servicePrivateKey).toBeUndefined();
    expect(redactString(`signer=${OTHER_PAIR_SIGNER}`)).not.toContain(OTHER_PAIR_SIGNER);
  });

  it("registers the alias spelling of a discarded working signer", async () => {
    const { errors } = await validateSilent(
      { bundle: adminBundleJson({ serviceSecret: OTHER_PAIR_SIGNER }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(redactString(`signer=${OTHER_PAIR_SIGNER}`)).not.toContain(OTHER_PAIR_SIGNER);
  });

  it("registers the discarded pair from an interactive paste too", async () => {
    const otherAdminKey = "hbradm_pasted_other_pair_value";
    const { deps } = scriptedDeps([
      bundleJson({ adminKey: otherAdminKey, adminServicePrivateKey: OTHER_PAIR_SIGNER }),
      "y",
    ]);

    await collectCredentials("bundle", deps);

    expect(redactString(`Authorization: Bearer ${otherAdminKey}`)).not.toContain(otherAdminKey);
    expect(redactString(`signer=${OTHER_PAIR_SIGNER}`)).not.toContain(OTHER_PAIR_SIGNER);
  });

  // `pickField` returns the FIRST key present and never looks at the rest, so a
  // paste carrying both signer spellings had its second value left unregistered
  // — the very leak this block closes for the other pair, reintroduced inside
  // it. The redaction sweep must visit every spelling; PARSING still takes the
  // first, which the assertions below pin.
  it("registers BOTH signer spellings when an admin bundle carries two", async () => {
    const { updates, errors } = await validateSilent(
      {
        bundle: adminBundleJson({
          servicePrivateKey: OTHER_PAIR_SIGNER,
          serviceSecret: SECOND_SPELLING_SIGNER,
        }),
      },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    // An admin bundle discards the working signer entirely, under either name.
    expect(updates.servicePrivateKey).toBeUndefined();
    expect(redactString(`a=${OTHER_PAIR_SIGNER}`)).not.toContain(OTHER_PAIR_SIGNER);
    expect(redactString(`b=${SECOND_SPELLING_SIGNER}`)).not.toContain(SECOND_SPELLING_SIGNER);
  });

  it("registers the ignored spelling while parsing still takes the first", async () => {
    const { updates, errors } = await validateSilent(
      {
        bundle: bundleJson({
          servicePrivateKey: OTHER_PAIR_SIGNER,
          serviceSecret: SECOND_SPELLING_SIGNER,
        }),
      },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    // Parsing semantics are untouched: the first spelling is what gets saved.
    expect(updates.servicePrivateKey).toBe(OTHER_PAIR_SIGNER);
    // The spelling the parse ignored is still redacted.
    expect(redactString(`b=${SECOND_SPELLING_SIGNER}`)).not.toContain(SECOND_SPELLING_SIGNER);
  });

  // Registering something that is not a credential is not free: `redactString`
  // matches substrings, so a junk value would scrub that run of text out of
  // every future line of output.
  it("does not register a malformed value from the discarded pair", async () => {
    const notAKey = "hbradm-not-a-well-formed-management-key";

    const { errors } = await validateSilent(
      { bundle: bundleJson({ adminKey: notAKey }) },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(redactString(`value=${notAKey}`)).toContain(notAKey);
  });
});

describe("validateSilent — address pins", () => {
  const okProbe = async () => "ok" as const;

  it("persists a bare --owner-address without probing anything", async () => {
    let probed = false;
    const { updates, clear, errors } = await validateSilent(
      { ownerAddress: OWNER_ADDRESS },
      async () => {
        probed = true;
        return "ok" as const;
      },
    );

    expect(errors).toEqual([]);
    expect(updates).toEqual({ webAccountAddress: OWNER_ADDRESS });
    expect(clear).toEqual([]);
    expect(probed).toBe(false);
  });

  it("persists a bare --key-admin-address", async () => {
    const { updates, errors } = await validateSilent(
      { keyAdminAddress: KEY_ADMIN_ADDRESS },
      okProbe,
    );

    expect(errors).toEqual([]);
    expect(updates).toEqual({ keyAdminAddress: KEY_ADMIN_ADDRESS });
  });

  // Merge semantics, matching the interactive manual path: only the bundle is
  // authoritative enough to remove a pin it did not set.
  it("leaves the other saved pin alone", async () => {
    const { clear } = await validateSilent({ ownerAddress: OWNER_ADDRESS }, okProbe, {
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });

    expect(clear).toEqual([]);
  });

  it("rejects a malformed address, names the flag, and writes nothing", async () => {
    const junk = "0xNOT_AN_ADDRESS_VALUE";
    const { updates, errors } = await validateSilent({ ownerAddress: junk }, okProbe);

    expect(updates).toEqual({});
    expect(errors.join(" ")).toContain("--owner-address");
    expect(errors.join(" ")).not.toContain(junk);
  });

  it("refuses an empty --owner-address on the flag path too", async () => {
    const { updates, errors } = await validateSilent(
      { apiKey: "hbr_x_value", ownerAddress: "" },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--owner-address");
    expect(updates).toEqual({});
  });

  it("rejects a malformed key-admin address the same way", async () => {
    const { updates, errors } = await validateSilent({ keyAdminAddress: "nope" }, okProbe);

    expect(updates).toEqual({});
    expect(errors.join(" ")).toContain("--key-admin-address");
  });

  it("treats an address flag alone as something to do", async () => {
    const { errors } = await validateSilent({ ownerAddress: OWNER_ADDRESS }, okProbe);
    expect(errors.join(" ")).not.toContain("No credentials given");
  });

  it("saves an address alongside a credential", async () => {
    const { updates, errors } = await validateSilent(
      { apiKey: "hbr_working_key_value", ownerAddress: OWNER_ADDRESS },
      okProbe,
    );

    expect(errors).toEqual([]);
    expect(updates.apiKey).toBe("hbr_working_key_value");
    expect(updates.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  // This branch is what made a silent `--api-key` install leave create_bucket
  // refusing. Warn only when no pin is resolvable from the write, the saved
  // file, or the env — an env-configured host must stay silent.
  it("warns on a silent --api-key write that leaves no owner pin", async () => {
    const { warnings, errors } = await validateSilent(
      { apiKey: "hbr_working_key_value" },
      okProbe,
      {},
      NO_ENV,
    );

    expect(errors).toEqual([]);
    expect(warnings).toEqual([NO_OWNER_PIN_WARNING]);
  });

  it("does not warn when a saved owner pin will survive the write", async () => {
    const { warnings } = await validateSilent(
      { apiKey: "hbr_working_key_value" },
      okProbe,
      { webAccountAddress: OWNER_ADDRESS },
      NO_ENV,
    );

    expect(warnings).toEqual([]);
  });

  it("does not warn when CONSOLE_WEB_ACCOUNT_ADDRESS is set", async () => {
    const { warnings } = await validateSilent(
      { apiKey: "hbr_working_key_value" },
      okProbe,
      {},
      { CONSOLE_WEB_ACCOUNT_ADDRESS: OWNER_ADDRESS },
    );

    expect(warnings).toEqual([]);
  });

  it("does not warn when the write itself carries --owner-address", async () => {
    const { warnings } = await validateSilent(
      { apiKey: "hbr_working_key_value", ownerAddress: OWNER_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(warnings).toEqual([]);
  });

  it("does not warn on a signer-only write", async () => {
    const { warnings } = await validateSilent({ serviceKey: VALID_SIGNER }, okProbe, {}, NO_ENV);

    expect(warnings).toEqual([]);
  });
});

describe("replacing an API key does not keep the previous key's signer", () => {
  // An API key and its service signer are a matched pair: the signer is the
  // on-chain address registered for that key. Carrying a signer across a key
  // change leaves uploads/downloads configured with two halves of two different
  // credentials, which fails at Seal time with a message that points nowhere near
  // the actual cause.
  const SAVED = { apiKey: "hbr_old_key_value", servicePrivateKey: VALID_SIGNER };
  const acceptingProbe = async () => "ok" as const;

  it("clears the saved signer when the user skips it for a new key", async () => {
    const { deps } = scriptedDeps(["hbr_new_key_value", "", "n"]);

    const { updates, clear } = await collectCredentials("api", deps, SAVED);

    expect(updates).toEqual({ apiKey: "hbr_new_key_value" });
    expect(clear).toEqual(["servicePrivateKey"]);
  });

  it("keeps the saved signer when the user explicitly says so", async () => {
    // The re-enter-the-key-to-fix-a-typo flow: the signer really is still valid,
    // so silently discarding it would be its own bug.
    const { deps } = scriptedDeps(["hbr_new_key_value", "", "y"]);

    const { updates, clear } = await collectCredentials("api", deps, SAVED);

    expect(updates).toEqual({ apiKey: "hbr_new_key_value" });
    expect(clear).toEqual([]);
  });

  it("defaults to clearing when the confirm is answered with a bare Enter", async () => {
    const { deps } = scriptedDeps(["hbr_new_key_value", "", ""]);

    const { clear } = await collectCredentials("api", deps, SAVED);

    expect(clear).toEqual(["servicePrivateKey"]);
  });

  it("does not ask at all when a new signer was supplied", async () => {
    const { deps, asked } = scriptedDeps(["hbr_new_key_value", VALID_SIGNER_2]);

    const { updates, clear } = await collectCredentials("api", deps, SAVED);

    expect(updates.servicePrivateKey).toBe(VALID_SIGNER_2);
    expect(clear).toEqual([]);
    expect(asked.some((q) => /keep/i.test(q))).toBe(false);
  });

  it("does not ask when there was no saved signer to lose", async () => {
    const { deps, asked } = scriptedDeps(["hbr_new_key_value", ""]);

    const { clear } = await collectCredentials("api", deps, { apiKey: "hbr_old_key_value" });

    expect(clear).toEqual([]);
    expect(asked.some((q) => /keep/i.test(q))).toBe(false);
  });

  it("leaves the working signer alone when only the management pair is set", async () => {
    const { deps } = scriptedDeps(["hbradm_management_key", VALID_SIGNER_2]);

    const { clear } = await collectCredentials("admin", deps, SAVED);

    expect(clear).toEqual([]);
  });

  it("silent mode clears the stale signer without prompting", async () => {
    // --silent has no channel to ask on, and retaining a mismatched pair is the
    // worse of the two failure modes: it fails later, at Seal, not here.
    const { updates, clear, errors } = await validateSilent(
      { apiKey: "hbr_new_key_value" },
      acceptingProbe,
      SAVED,
    );

    expect(errors).toEqual([]);
    expect(updates).toEqual({ apiKey: "hbr_new_key_value" });
    expect(clear).toEqual(["servicePrivateKey"]);
  });

  it("silent mode keeps the signer when it is supplied alongside the key", async () => {
    const { updates, clear } = await validateSilent(
      { apiKey: "hbr_new_key_value", serviceKey: VALID_SIGNER_2 },
      acceptingProbe,
      SAVED,
    );

    expect(updates.servicePrivateKey).toBe(VALID_SIGNER_2);
    expect(clear).toEqual([]);
  });
});

describe("parseCredentialBundle", () => {
  const OWNER_ADDRESS = `0x${"a".repeat(64)}`;
  const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;
  const API_KEY = "hbr_bundle_key_value";

  const validBundle = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      apiKey: API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
      ...overrides,
    });

  it("parses a well-formed v1 bundle", () => {
    const result = parseCredentialBundle(validBundle());
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle).toEqual({
      kind: "api",
      apiKey: API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
  });

  it("accepts null for both webAccountAddress and keyAdminAddress", () => {
    const result = parseCredentialBundle(
      validBundle({ webAccountAddress: null, keyAdminAddress: null }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle.webAccountAddress).toBeNull();
    expect(result.bundle.keyAdminAddress).toBeNull();
  });

  it("accepts a null webAccountAddress paired with a real keyAdminAddress", () => {
    const result = parseCredentialBundle(validBundle({ webAccountAddress: null }));
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle.webAccountAddress).toBeNull();
    expect(result.bundle.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
  });

  it("rejects a raw string that is not valid JSON, without echoing it", () => {
    const raw = "definitely not json {{{";
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(raw);
    expect(result.error.toLowerCase()).toContain("json");
  });

  it("rejects JSON that is not an object (array), without echoing it", () => {
    const raw = JSON.stringify([1, 2, 3]);
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(raw);
  });

  it("rejects JSON that is not an object (null), without echoing it", () => {
    const result = parseCredentialBundle("null");
    expect("error" in result).toBe(true);
  });

  it("rejects a future/unknown version rather than best-effort parsing it", () => {
    const raw = validBundle({ v: 2 });
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(raw);
    expect(result.error).not.toContain(API_KEY);
    expect(result.error.toLowerCase()).toContain("version");
  });

  it("accepts a bundle missing the v field (a pasted config.json has none)", () => {
    const parsed = JSON.parse(validBundle()) as Record<string, unknown>;
    delete parsed["v"];
    const result = parseCredentialBundle(JSON.stringify(parsed));
    expect("bundle" in result).toBe(true);
  });

  it("rejects a missing apiKey without echoing any other field", () => {
    const parsed = JSON.parse(validBundle()) as Record<string, unknown>;
    delete parsed["apiKey"];
    const raw = JSON.stringify(parsed);
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(raw);
    expect(result.error).not.toContain(VALID_SIGNER);
  });

  it("rejects an apiKey that does not match the hbr_ format, without echoing it", () => {
    const badKey = "not_an_hbr_key_at_all";
    const raw = validBundle({ apiKey: badKey });
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(badKey);
    expect(result.error).not.toContain(raw);
  });

  it("rejects a missing servicePrivateKey without echoing any other field", () => {
    const parsed = JSON.parse(validBundle()) as Record<string, unknown>;
    delete parsed["servicePrivateKey"];
    const raw = JSON.stringify(parsed);
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(raw);
    expect(result.error).not.toContain(API_KEY);
  });

  it("rejects a servicePrivateKey that does not genuinely Bech32-decode, without echoing it", () => {
    const result = parseCredentialBundle(validBundle({ servicePrivateKey: GARBLED_SIGNER }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(GARBLED_SIGNER);
  });

  it("rejects a servicePrivateKey that merely looks right (prefix heuristic would pass)", () => {
    const looksRight = `suiprivkey1${"x".repeat(30)}`;
    const result = parseCredentialBundle(validBundle({ servicePrivateKey: looksRight }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(looksRight);
  });

  it("rejects a non-null, non-address webAccountAddress, without echoing it", () => {
    const badAddress = "not-an-address";
    const raw = validBundle({ webAccountAddress: badAddress });
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(badAddress);
    expect(result.error).not.toContain(raw);
  });

  it("names ownerAddress when that alias is the only owner field and it is malformed", () => {
    const result = parseCredentialBundle(
      validBundle({ webAccountAddress: undefined, ownerAddress: "0x1" }),
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).toBe("bundle ownerAddress is not null or a valid Sui address");
    expect(result.error).not.toContain("webAccountAddress");
  });

  // Symmetric coverage on the second address field, same guard.
  it("rejects a non-null, non-address keyAdminAddress, without echoing it", () => {
    const badAddress = "0xnothex";
    const raw = validBundle({ keyAdminAddress: badAddress });
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).not.toContain(badAddress);
    expect(result.error).not.toContain(raw);
  });

  it("does not depend on key order when parsing", () => {
    const reordered = JSON.stringify({
      keyAdminAddress: KEY_ADMIN_ADDRESS,
      webAccountAddress: OWNER_ADDRESS,
      servicePrivateKey: VALID_SIGNER,
      apiKey: API_KEY,
      v: 1,
    });
    const result = parseCredentialBundle(reordered);
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    if (result.bundle.kind !== "api") throw new Error("expected a working bundle");
    expect(result.bundle.apiKey).toBe(API_KEY);
  });

  it("parses a saved config.json (no v, extra admin/baseUrl keys ignored)", () => {
    const result = parseCredentialBundle(
      JSON.stringify({
        apiKey: API_KEY,
        servicePrivateKey: VALID_SIGNER,
        adminKey: "hbradm_ignored",
        adminServicePrivateKey: VALID_SIGNER,
        baseUrl: "https://api.testnet.console.walrus.xyz",
        webAccountAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle).toEqual({
      kind: "api",
      apiKey: API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
  });

  it("round-trips saveConfigFile output through parseCredentialBundle", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-bundle-roundtrip-"));
    const originalEnv = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    try {
      saveConfigFile({
        apiKey: API_KEY,
        servicePrivateKey: VALID_SIGNER,
        webAccountAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      });
      const raw = fs.readFileSync(getConfigFilePath(), "utf-8");
      expect(raw.trimEnd().includes("\n")).toBe(false);
      const result = parseCredentialBundle(raw);
      expect("bundle" in result).toBe(true);
      if (!("bundle" in result)) throw new Error("expected a bundle");
      expect(result.bundle).toEqual({
        kind: "api",
        apiKey: API_KEY,
        servicePrivateKey: VALID_SIGNER,
        webAccountAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      });
    } finally {
      process.env = originalEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses when webAccountAddress and ownerAddress disagree", () => {
    const other = `0x${"c".repeat(64)}`;
    const result = parseCredentialBundle(
      validBundle({ webAccountAddress: OWNER_ADDRESS, ownerAddress: other }),
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).toMatch(/webAccountAddress/);
    expect(result.error).toMatch(/ownerAddress/);
    expect(result.error).not.toContain(OWNER_ADDRESS);
    expect(result.error).not.toContain(other);
  });

  it("accepts both owner spellings when they name the same address", () => {
    const result = parseCredentialBundle(
      validBundle({
        webAccountAddress: OWNER_ADDRESS,
        ownerAddress: `0x${"A".repeat(64)}`,
      }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  // The spelling the Console's `buildCredentialBundle` emits TODAY for every
  // working-key reveal — not a legacy shape kept alive for old pastes.
  it("parses the Console reveal's live serviceSecret / ownerAddress spelling", () => {
    const result = parseCredentialBundle(
      JSON.stringify({
        v: 1,
        apiKey: API_KEY,
        serviceSecret: VALID_SIGNER,
        ownerAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle.kind).toBe("api");
    if (result.bundle.kind !== "api") throw new Error("expected api bundle");
    expect(result.bundle.servicePrivateKey).toBe(VALID_SIGNER);
    expect(result.bundle.webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("rejects an hbradm_ value in apiKey as a management key, without echoing it", () => {
    const badKey = "hbradm_not_a_working_key_value";
    const raw = validBundle({ apiKey: badKey });
    const result = parseCredentialBundle(raw);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error.toLowerCase()).toContain("management");
    expect(result.error).not.toContain(badKey);
    expect(result.error).not.toContain(raw);
  });

  it("parses an admin bundle with adminKey + adminServicePrivateKey and no apiKey", () => {
    const adminKey = "hbradm_management_key_value";
    const result = parseCredentialBundle(
      JSON.stringify({
        v: 1,
        adminKey,
        adminServicePrivateKey: VALID_SIGNER,
        ownerAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle).toEqual({
      kind: "admin",
      adminKey,
      adminServicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
  });

  it("rejects a working key in adminKey, without echoing it", () => {
    const badKey = "hbr_working_key_value";
    const result = parseCredentialBundle(
      JSON.stringify({
        v: 1,
        adminKey: badKey,
        adminServicePrivateKey: VALID_SIGNER,
        ownerAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      }),
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error.toLowerCase()).toMatch(/everyday|working|api key/);
    expect(result.error).not.toContain(badKey);
  });

  // `serviceSecret` is accepted on a WORKING bundle only, because Harbor reveals
  // already in circulation use that name. A management bundle is new, so it has
  // exactly one spelling and no back-compatibility to keep.
  it("an admin bundle needs adminServicePrivateKey (no serviceSecret alias)", () => {
    const result = parseCredentialBundle(
      JSON.stringify({ v: 1, adminKey: "hbradm_x_value", serviceSecret: VALID_SIGNER }),
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error).toContain("adminServicePrivateKey");
  });

  // The bundle fields are JSON, not a chooser: telling the operator to "re-run and
  // choose Management key" is advice about a prompt they are not standing at. Name
  // the field that should have carried the value instead.
  it("names the field rather than the chooser when a key is in the wrong bundle field", () => {
    const apiField = parseCredentialBundle(bundleJson({ apiKey: "hbradm_management_key_value" }));
    if (!("error" in apiField)) throw new Error("expected an error");
    expect(apiField.error).toContain("adminKey");
    expect(apiField.error).not.toContain("Re-run");

    const adminField = parseCredentialBundle(
      JSON.stringify({
        v: 1,
        adminKey: "hbr_working_key_value",
        adminServicePrivateKey: VALID_SIGNER,
      }),
    );
    if (!("error" in adminField)) throw new Error("expected an error");
    expect(adminField.error).toContain("apiKey");
    expect(adminField.error).not.toContain("Re-run");
  });
});
