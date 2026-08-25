import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
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
  validateSilent,
} from "../src/credentials.js";
import { getConfigFilePath, saveConfigFile } from "../src/configFile.js";
import { toRealPath } from "../src/pathSandbox.js";

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

const bundleJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    apiKey: BUNDLE_API_KEY,
    servicePrivateKey: VALID_SIGNER,
    webAccountAddress: OWNER_ADDRESS,
    keyAdminAddress: KEY_ADMIN_ADDRESS,
    ...overrides,
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
    });
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

  it("refuses a bundle combined with an address flag", async () => {
    const { updates, errors } = await validateSilent(
      { bundle: bundleJson(), ownerAddress: STALE_ADDRESS },
      okProbe,
      {},
      NO_ENV,
    );

    expect(updates).toEqual({});
    expect(errors.join(" ")).toContain("--credential-bundle");
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
  it("configures the management pair alongside a bundle", async () => {
    const { updates, errors } = await validateSilent(
      {
        bundle: bundleJson(),
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
      keyAdminAddress: KEY_ADMIN_ADDRESS,
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
    expect(result.bundle.apiKey).toBe(API_KEY);
  });

  it("parses a saved config.json (no v, extra admin/baseUrl keys ignored)", () => {
    const result = parseCredentialBundle(
      JSON.stringify({
        apiKey: API_KEY,
        servicePrivateKey: VALID_SIGNER,
        adminKey: "hbradm_ignored",
        adminServicePrivateKey: VALID_SIGNER,
        baseUrl: "https://api.testnet.patestation.org",
        webAccountAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      }),
    );
    expect("bundle" in result).toBe(true);
    if (!("bundle" in result)) throw new Error("expected a bundle");
    expect(result.bundle).toEqual({
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

  it("still parses a pre-unification reveal (serviceSecret / ownerAddress)", () => {
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
    expect(result.bundle.servicePrivateKey).toBe(VALID_SIGNER);
    expect(result.bundle.webAccountAddress).toBe(OWNER_ADDRESS);
  });
});
