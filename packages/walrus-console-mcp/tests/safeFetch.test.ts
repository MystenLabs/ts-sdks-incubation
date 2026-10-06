import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRedirectGuard, UnapprovedRedirectError } from "../src/safeFetch";

// the security review — a compromised/impersonated Console API must not be able to
// redirect this client to an attacker-chosen or internal address. These tests
// stub `globalThis.fetch` directly (the same pattern consoleApiClient.upload
// /download tests use), so no real network call is ever made.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

const ok = (body = "ok") => new Response(body, { status: 200 });

describe("fetchWithRedirectGuard", () => {
  it("returns a non-redirect response immediately", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(ok());

    const res = await fetchWithRedirectGuard("https://api.walrus.xyz/x");

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to an allowed host", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://cdn.walrus.xyz/final"))
      .mockResolvedValueOnce(ok("final-body"));

    const res = await fetchWithRedirectGuard("https://api.walrus.xyz/x");

    expect(await res.text()).toBe("final-body");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]).toBe("https://cdn.walrus.xyz/final");
  });

  it("refuses to follow a redirect to a disallowed host, without ever requesting it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      redirectTo("http://169.254.169.254/latest/meta-data/"),
    );

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/x")).rejects.toBeInstanceOf(
      UnapprovedRedirectError,
    );
    // The whole point: the attacker-chosen host is never actually requested.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // A malformed Location used to throw a raw TypeError out of `new URL()`,
  // which is not an UnapprovedRedirectError — so the callers' `instanceof`
  // checks missed it and the user got a generic "upload/download failed"
  // for what is actually a refused redirect. Unparseable is a refusal too.
  it("treats an unparseable Location as a refused redirect, not an internal error", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectTo("http://[::1"));

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/x")).rejects.toBeInstanceOf(
      UnapprovedRedirectError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // security review round 2, major 2: this message reaches ConsoleApiError
  // verbatim, which an MCP tool result returns to the caller. Only the host may
  // appear; the path/query/fragment are attacker-chosen and must never ride
  // along into something a model reads.
  it("names only the host in its message, never the full redirect target", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      redirectTo("http://169.254.169.254/latest/meta-data/?secret=leaked"),
    );

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/x")).rejects.toThrow(
      "Refused to follow a redirect to an unapproved host: 169.254.169.254",
    );
  });

  it("resolves a relative Location against the current URL before checking the allowlist", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("/final"))
      .mockResolvedValueOnce(ok("relative-ok"));

    const res = await fetchWithRedirectGuard("https://api.walrus.xyz/start");

    expect(await res.text()).toBe("relative-ok");
    expect(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]).toBe("https://api.walrus.xyz/final");
  });

  it("returns the redirect response as-is when there is no Location header", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 302 }));

    const res = await fetchWithRedirectGuard("https://api.walrus.xyz/x");

    expect(res.status).toBe(302);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/1"))
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/2"))
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/3"));

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/0")).rejects.toThrow(
      /too many redirects/i,
    );
  });

  it("sets redirect: manual on every hop and forwards the rest of init unchanged", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      redirect: "manual",
    });
  });

  it("accepts a URL object as input", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard(new URL("https://api.walrus.xyz/x"));

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe("https://api.walrus.xyz/x");
  });

  it("forwards a bodyless Request object's own method and headers", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard(
      new Request("https://api.walrus.xyz/x", {
        method: "DELETE",
        headers: { "x-test": "1" },
      }),
    );

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.walrus.xyz/x");
    expect(init).toMatchObject({ method: "DELETE" });
    expect(new Headers((init as RequestInit).headers).get("x-test")).toBe("1");
  });

  it("refuses a Request object that carries a body, rather than silently dropping it", async () => {
    const withBody = new Request("https://api.walrus.xyz/x", {
      method: "POST",
      body: "payload",
    });

    await expect(fetchWithRedirectGuard(withBody)).rejects.toThrow(/not supported/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("treats loopback as an allowed redirect target when the hop it came from is already loopback (local dev)", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("http://localhost:9999/final"))
      .mockResolvedValueOnce(ok("dev-ok"));

    const res = await fetchWithRedirectGuard("http://localhost:8080/x");

    expect(await res.text()).toBe("dev-ok");
  });

  it("refuses a redirect from a real host into loopback, without ever requesting it", async () => {
    // A compromised or impersonated *production* Console redirecting into
    // 127.0.0.1 is exactly the SSRF the security review exists to close — allowing
    // it here would just be a laxer version of the same hole the disallowed-
    // host test above already covers.
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectTo("http://127.0.0.1:9/"));

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/x")).rejects.toBeInstanceOf(
      UnapprovedRedirectError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect from a real host into localhost by name, not just by IP", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectTo("http://localhost:9999/"));

    await expect(fetchWithRedirectGuard("https://api.walrus.xyz/x")).rejects.toBeInstanceOf(
      UnapprovedRedirectError,
    );
  });

  it("drops Authorization on a hop that crosses origins, even to another allowed host", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://cdn.walrus.xyz/final"))
      .mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      headers: { Authorization: "Bearer secret", "x-keep": "1" },
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    const headers = new Headers((secondInit as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
    // Collateral damage check: only the credential-bearing headers are
    // stripped, not the whole header set.
    expect(headers.get("x-keep")).toBe("1");
  });

  // COMG-1053. Attribution, not a credential, so it grants nothing wherever it lands.
  // It is stripped anyway: only Console reads it, and it is the one header that would
  // otherwise travel where `Authorization` deliberately does not.
  it("drops X-Console-Client on a hop that crosses origins", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://cdn.walrus.xyz/final"))
      .mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      headers: { "X-Console-Client": "mcp", "x-keep": "1" },
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    const headers = new Headers((secondInit as RequestInit).headers);
    expect(headers.get("x-console-client")).toBeNull();
    expect(headers.get("x-keep")).toBe("1");
  });

  it("keeps X-Console-Client across a same-origin hop", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/y"))
      .mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      headers: { "X-Console-Client": "mcp" },
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    expect(new Headers((secondInit as RequestInit).headers).get("x-console-client")).toBe("mcp");
  });

  it("keeps Authorization across a same-origin hop (different path, same host)", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/y"))
      .mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      headers: { Authorization: "Bearer secret" },
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    expect(new Headers((secondInit as RequestInit).headers).get("authorization")).toBe(
      "Bearer secret",
    );
  });

  it("downgrades 301/302/303 to a bodyless GET on the next hop", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectTo("https://api.walrus.xyz/y"))
      .mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      method: "POST",
      body: "the upload bytes",
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    expect((secondInit as RequestInit).method).toBe("GET");
    expect((secondInit as RequestInit).body).toBeUndefined();
  });

  // The body is gone on every downgrade (301/302/303 and 307/308 alike), so a
  // stale Content-Type describing it must not ride along either.
  it.each([302, 307])(
    "strips Content-Type once the body is dropped (status %i)",
    async (status) => {
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { location: "https://api.walrus.xyz/y" } }),
        )
        .mockResolvedValueOnce(ok());

      await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "the upload bytes",
      });

      const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
      expect(new Headers((secondInit as RequestInit).headers).has("content-type")).toBe(false);
    },
  );

  it("preserves method but drops the body on a SAME-ORIGIN 307/308 hop", async () => {
    const redirect307 = new Response(null, {
      status: 307,
      headers: { location: "https://api.walrus.xyz/y" },
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirect307).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      method: "POST",
      body: "the upload bytes",
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    expect((secondInit as RequestInit).method).toBe("POST");
    expect((secondInit as RequestInit).body).toBeUndefined();
  });

  // security review round 2, major 1: 307/308 used to replay the body
  // verbatim, so a compromised Console could answer a multipart upload with a
  // 307 (same-origin OR to a different, still-allowlisted walrus.xyz host) and
  // receive the request body — the encrypted file bytes — even though the
  // credential header is already stripped on a cross-origin hop. The method
  // alone carries nothing to exfiltrate, so it is still preserved either way.
  it("also drops the body on a CROSS-ORIGIN 307/308 hop, even to an otherwise-allowed host", async () => {
    const redirect308 = new Response(null, {
      status: 308,
      headers: { location: "https://cdn.walrus.xyz/collect" },
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirect308).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x", {
      method: "POST",
      body: "the upload bytes",
    });

    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1] ?? [];
    expect((secondInit as RequestInit).method).toBe("POST");
    expect((secondInit as RequestInit).body).toBeUndefined();
  });

  it.each([300, 304])(
    "does not treat a %i as a redirect, even with a Location header",
    async (status) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(null, { status, headers: { location: "https://api.walrus.xyz/y" } }),
      );

      const res = await fetchWithRedirectGuard("https://api.walrus.xyz/x");

      expect(res.status).toBe(status);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels an intermediate redirect's body instead of leaving it dangling", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const redirectWithBody = redirectTo("https://cdn.walrus.xyz/final");
    Object.defineProperty(redirectWithBody, "body", { value: { cancel } });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectWithBody).mockResolvedValueOnce(ok());

    await fetchWithRedirectGuard("https://api.walrus.xyz/x");

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
