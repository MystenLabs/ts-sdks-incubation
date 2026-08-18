import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import {
  classifyProbe,
  collectCredentials,
  isValidAdminKeyFormat,
  isValidApiKeyFormat,
  isValidServiceKeyFormat,
  keyKindOf,
  mismatchMessage,
  probeKey,
  validateSilent,
} from "../src/credentials.js";

/**
 * Real, decodable signers for tests that exercise `decodeSuiPrivateKey`
 * validation — a hand-typed placeholder like `suiprivkey1qqq…` no longer
 * passes format checks, since those now actually decode the value.
 */
const VALID_SIGNER = Ed25519Keypair.generate().getSecretKey();
const VALID_SIGNER_2 = Ed25519Keypair.generate().getSecretKey();

/** Well-formed prefix, wrong length/checksum — the "pasted garbage" case. */
const GARBLED_SIGNER = `suiprivkey1${"x".repeat(59)}`;

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
  const messages: string[] = [];
  return {
    asked,
    messages,
    deps: {
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
      ok: (m: string) => messages.push(`ok:${m}`),
      fail: (m: string) => messages.push(`fail:${m}`),
      warn: (m: string) => messages.push(`warn:${m}`),
      info: (m: string) => messages.push(`info:${m}`),
      probe: async () => "ok" as const,
    },
  };
};

describe("collectCredentials", () => {
  it("api: collects the key and the optional signer", async () => {
    const { deps } = scriptedDeps(["hbr_working_key_value", VALID_SIGNER]);
    const updates = await collectCredentials("api", deps);
    expect(updates).toEqual({
      apiKey: "hbr_working_key_value",
      servicePrivateKey: VALID_SIGNER,
    });
  });

  it("api: an empty signer is skipped, not saved", async () => {
    const { deps } = scriptedDeps(["hbr_working_key_value", ""]);
    const updates = await collectCredentials("api", deps);
    expect(updates).toEqual({ apiKey: "hbr_working_key_value" });
  });

  it("api: a garbled signer is rejected and re-prompts until a real key is given", async () => {
    const { deps, messages } = scriptedDeps([
      "hbr_working_key_value",
      GARBLED_SIGNER,
      VALID_SIGNER,
    ]);
    const updates = await collectCredentials("api", deps);
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
    const updates = await collectCredentials("admin", deps);
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
    const updates = await collectCredentials("admin", deps);
    expect(updates.adminServicePrivateKey).toBe(VALID_SIGNER);
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("decode"))).toBe(true);
  });

  it("rejects a management key pasted into the api step and re-prompts", async () => {
    const { deps, messages } = scriptedDeps(["hbradm_wrong_slot", "hbr_working_key_value", ""]);
    const updates = await collectCredentials("api", deps);
    expect(updates.apiKey).toBe("hbr_working_key_value");
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("management key"))).toBe(true);
  });

  it("rejects a working key pasted into the admin step and re-prompts", async () => {
    const { deps, messages } = scriptedDeps([
      "hbr_wrong_slot",
      "hbradm_management_key",
      VALID_SIGNER,
    ]);
    const updates = await collectCredentials("admin", deps);
    expect(updates.adminKey).toBe("hbradm_management_key");
    expect(messages.some((m) => m.startsWith("fail:") && m.includes("everyday API key"))).toBe(
      true,
    );
  });

  it("re-prompts when the probe rejects the key", async () => {
    const answers = ["hbr_rejected_key", "hbr_working_key_value", ""];
    const asked: string[] = [];
    let call = 0;
    const updates = await collectCredentials("api", {
      ask: async (q: string) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
      ok: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
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
    const updates = await collectCredentials("both", deps);
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
