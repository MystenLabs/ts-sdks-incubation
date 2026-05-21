# 15 Wallet (distilled)

## Purpose

A dev-only **server-backed signer** that lets browser-based example apps use accounts pinned in
devstack configuration for signing **without shipping private keys into the frontend bundle**. The
wallet is a long-lived host Node HTTP server on the supervisor; the browser-side counterpart is a
wallet-standard adapter (the `DevstackSignerAdapter` in `dev-wallet`) that the dApp consumes through
dapp-kit. The devstack wallet itself has no chain client — it is purely a router from HTTP requests
to the resolved account values' sign closures.

This is the only wallet model: there is no in-browser keypair wallet bundled with devstack. The
browser-side adapter is the wallet-standard surface; the devstack wallet service is its server.

## Responsibilities

- Resolve a user-declared set of account references at boot and key each resolved account by
  **address** for handler lookup.
- Bind and operate a single host-local HTTP server that serves a small protocol under
  `/api/v1/devstack/*` covering health probe, accounts listing, transaction signing, and
  personal-message signing.
- Mint or reuse a per-stack pairing token, persist it with restrictive file mode, and embed it in
  the URL fragment of the published pair URL.
- Enforce browser-only auth on every request: mandatory `Origin` header against an allowlist, plus a
  constant-time bearer-token comparison.
- Publish a router-fronted public hostname for the wallet via the Traefik file-provider so browsers
  reach it on the well-known wallet entrypoint port through a per-stack hostname.
- Register a wallet endpoint with the endpoint registry so it lands in the manifest projection
  consumed by codegen.
- Provide a redacted display projection for the TUI that hides the pairing token from
  screen-share/scrollback.
- Tear down deterministically: drop keep-alive sockets, await server close, release the allocated
  port, remove the dynamic router YAML.

## Devstack ↔ browser boundary

The wallet is the seam between the devstack supervisor process and the browser-side dApp. Treat the
boundary as a hard contract.

**What flows devstack → browser:**

- The published wallet endpoint (router-fronted public URL and pairing URL with the token in the URL
  fragment), surfaced through the manifest on disk.
- The set of resolved accounts (name, address, scheme, public key, source classification of `real`
  vs `impersonate`) returned over the accounts endpoint.
- Signed bytes produced by an account's sign closure (transaction signature, personal-message
  signature).
- Auth/policy responses (CORS preflight, origin/bearer rejections, structured 4xx/5xx error bodies).

**What flows browser → devstack:**

- Bearer-authenticated, origin-checked sign requests carrying an address plus the bytes to sign.
- Health probe and accounts query.

**What MUST NOT cross:**

- **Account private keys, in either direction.** They live only inside the resolved account's sign
  closures on the devstack side.
- The pairing token in any channel other than the pair URL's fragment and the
  `Authorization: Bearer` request header. It must never appear in log lines, in URL query strings,
  in referer headers, in error bodies, or in the TUI display projection.
- Any direct import of dapp-kit / wallet-standard symbols from devstack service code. Devstack
  speaks only HTTP; the wallet-standard surface lives entirely in the browser-side adapter package.
- Devstack-internal Effect machinery (tags, layers, services, the supervisor fiber context). Only
  serialized JSON crosses the wire.

**How the vite plugin separates concerns:**

The example app runs under vite on a separate well-known entrypoint port (the vite entrypoint), at
an origin like `http://dev.<app>.localhost:<vite-port>` and `http://localhost:<vite-port>`. That
browser tab is the only allowed Origin out of the box; the wallet auto-derives those two origins
from the identity and the vite entrypoint at boot. A vite plugin owns the in-page UI panel that
hosts the browser-side signer adapter: it loads the manifest, instantiates the adapter pointed at
the published wallet endpoint, presents the adapter to dapp-kit, and is the only place that imports
dapp-kit / wallet-standard. Devstack's service code never sees a wallet-standard type. The plugin is
also the natural home for any paired-wallet UX (pair prompt, account picker, fork-control
affordances) — anything beyond the HTTP wire stays browser-side.

A separate browser-facing UI **is not** served from the wallet's own port: the wallet port is
API-only and any non-`/api/v1/devstack/*` path 404s. The in-page UI lives at the vite origin, not at
the wallet origin.

## Lifecycle states

1. **Waiting on upstream.** Wait for the chain service for ordering (no field read), then resolve
   every declared account tag, capturing each resolved account into an address-keyed map.
   Account-resolution failures propagate as the wallet's boot error.
2. **Resource acquisition.** Allocate a host port via the port allocator (forward-scanning from the
   configured preference), resolve the bind address (default loopback only), resolve identity for
   hostname composition, and resolve the on-disk token path (preferring the canonical
   state-dir-rooted location, with a fallback when no state store is configured).
3. **Token reconcile.** Read the existing token file if it parses as the expected 32-hex shape and
   reuse it; otherwise mint a fresh 16-byte random token and write it atomically with restrictive
   file mode. Warm starts and snapshot restores both go through this path so prior pairings survive.
4. **Origin allowlist composition.** Auto-derive the dev and localhost origins on the vite
   entrypoint, then merge any caller-supplied extras.
5. **Context capture.** Capture the supervisor's full fiber context (logger sink, tracer, fiber
   refs) for replay inside every async HTTP handler. **Must happen before the HTTP server starts**
   or in-flight sign handlers will run on a fresh default runtime and lose observability.
6. **Listen.** Start the HTTP server on the resolved bind address and allocated port. Install a
   finalizer that drops keep-alive connections, awaits the server's close callback, and then
   releases the port.
7. **Router publication.** Look up the wallet router entrypoint and write a file-provider YAML
   mapping the per-stack hostname to the local upstream. Docker errors here are warn-logged and boot
   continues. Install a finalizer to remove the YAML.
8. **Endpoint publication.** Compose the public URL and pair URL (token in the fragment, never the
   query) and publish them to the endpoint registry under the canonical wallet endpoint name.
9. **Serving.** Each request runs under the captured supervisor context as an independent async
   fiber. No global locks. Per-request correlation IDs ride log lines.
10. **Teardown.** Finalizers run LIFO: remove router YAML, drop sockets, await server close, release
    port. The token file and the manifest survive teardown.

## Inputs / dependencies

- **Identity.** App, stack, and network triple — drives router hostnames, router id, canonical token
  path, and auto-derived origins.
- **Chain (sui) service.** Yielded for topological ordering only; no field consumption. The wallet
  must come up strictly after the chain is ready so account funding has completed.
- **Account references.** Caller supplies a list of account tag references; each is yielded to
  impose the funding-before-serving dependency edge AND to capture its resolved value into the
  address-keyed map.
- **Port allocator.** Forward-scanning allocator; produces the actual bind port and is invoked again
  in the finalizer to release it.
- **State-store config (optional).** When present, anchors the canonical token path; when absent, a
  fallback path is computed from identity plus the resolved app directory.
- **Router primitives.** A function that resolves an entrypoint name to its well-known port, a
  function that composes a per-stack router hostname, a function that composes a router id, and the
  file-provider write/remove operations.
- **Endpoint registry.** The publication target.
- **Atomic-write primitive.** For the token file.
- **Topological scheduler hint.** Upstream-keys lifting that names the chain service and every
  account tag, so layer build sees the edges and orders the wallet correctly.
- **Configuration knobs (caller-supplied):** the account references, optional extra allowed origins,
  optional preferred port, optional bind address.
- **Environment overrides:** dynamic router config directory, state directory.

## Outputs / capabilities provided

- **Endpoint registry entry** under the canonical wallet endpoint name with the router-fronted
  public URL, kind classification of `wallet`, and a pair URL whose fragment carries the pairing
  token. This entry is what codegen and the manifest writer project into the on-disk manifest for
  browser consumption.
- **Resolved wallet tag value** carrying the public URL, the pair URL, the endpoint descriptor, and
  the actual local bind port. Today only the manifest-emit + browser-side adapter consume it;
  in-tree there are no service-to-service yields against the wallet tag.
- **HTTP protocol** at the well-known prefix covering health probe, accounts listing, transaction
  signing, and personal-message signing, plus OPTIONS preflight handling.
- **Persistent token file** (mode `0o600`) holding the 32-hex pairing token, written through
  `runtime/<wallet>/token` and captured by the blanket runtime snapshot.
- **Transient dynamic router YAML** under the file-provider directory registering the wallet
  upstream; cleaned by finalizer.
- **TUI display projection** — title plus a redacted pair URL.

## Invariants and constraints

**Token pairing:**

- The pairing token is the only browser-issued credential. It is 32 hex chars on the wire (16 bytes
  random) and is reused across warm starts and snapshot restores so existing pairings survive.
- The token MUST live in the URL fragment, never the query — fragments are not sent to servers and
  most browsers don't write them to referrer headers.
- The token file MUST be written with restrictive permissions (owner read/write only). The token
  grants signing capability; world-readable would leak it via co-tenant processes.
- Bearer comparison MUST be constant-time; a naive equality check short-circuits and leaks the token
  byte-by-byte to a remote attacker via timing.
- Token redaction in the display projection is mandatory; the pair URL must be redacted in any
  user-visible projection.

**Security boundary:**

- Default bind address MUST be loopback only. The wallet's signing endpoints must not be reachable
  from other devices on the LAN. The router fronts the public hostname via the host-docker bridge; a
  non-loopback default exists only as an explicit caller override for devcontainer/WSL setups where
  the browser is on another interface.
- `Origin` header is mandatory on every protocol request. The bearer-token check alone would let
  non-browser tooling (curl, service workers, `file://` pages) through; the Origin requirement
  closes that bypass.
- Bodies MUST be size-capped (well above largest expected sign-tx payload) and the cap MUST be
  enforced during stream consumption, not after buffering, to prevent OOM by adversarial streaming.
- Tokens MUST NOT appear in log lines, error bodies, or trace annotations. Only a boolean "bearer
  valid" classification rides logs.

**Layering / boundary purity:**

- Devstack service code MUST NOT import from dapp-kit or wallet-standard. The wallet protocol is the
  only contract between devstack and the browser. The browser-side adapter package is the sole home
  for wallet-standard types.
- The wire-protocol path constants live on the devstack side; the browser-side adapter mirrors them.
  Either the mirror must be kept in byte-level sync by a coherence test OR the constants must be
  hoisted to a third tiny package both sides depend on (eliminating the workspace-cycle that forces
  the mirror today).
- The wallet has no chain client of its own — all chain interaction is delegated to the resolved
  account's sign closures.
- Sign handlers MUST run under the captured supervisor context so observability (logger sink,
  tracer, fiber refs) is inherited. The capture MUST happen before the HTTP server starts accepting
  connections.

**Address-keyed lookup:**

- The internal account map MUST be keyed by address, not by name. Sign requests carry only an
  address; name-keyed storage would force a reverse lookup the server can't do.

**Lifecycle:**

- Port release sequence is load-bearing: drop keep-alive sockets first, await the server's close
  callback, then release the port via the allocator. Skipping the socket-drop step leaves a held
  port that prevents the next session's listener from binding.
- The topological scheduler hint MUST name every account tag plus the chain service. Without those
  upstream edges the wallet body's yields fire at the wrong level and account resolution fails.

**Operational:**

- Router YAML write failure is non-fatal — it warn-logs and boot continues. The router-fronted
  public hostname becomes unreachable but the direct local-port form still works for callers that
  read the bind port off the manifest.

## Edge cases and known failure modes

- **No free port near the preference.** Allocator failure surfaces as a listen-phase boot error;
  supervisor boot fails. No retry.
- **Listen syscall failure** (e.g. privileged port denied). Listen-phase boot error. Recovery:
  change the preferred port.
- **Wallet router entrypoint not registered.** Listen-phase boot error — indicates the engine's
  router-entrypoint definitions did not load. Bug class.
- **Account resolution failure.** The account's own error propagates as the wallet boot error.
- **Token file write failure (ENOSPC, EROFS).** Warn-logged, boot continues with the freshly-minted
  in-memory token. UX degrades to re-pair every boot since nothing persists.
- **Existing token file malformed.** Silently re-minted. Existing browser-side pairings break with
  no notification — a pairing invalidation surface is missing.
- **Router file-provider YAML write fails.** Warn-logged; the router hostname stops working but the
  wallet itself is up.
- **Origin missing on a protocol request.** Reject with `403`. This is the non-browser-tooling
  fence.
- **Origin not in allowlist.** Reject with `403`. Recovery is to declare the extra origin in caller
  config.
- **Bearer missing or wrong.** `401`. Recovery is to re-pair.
- **Unknown address on a sign request.** `404`. Browser-side account picker should never send a
  known-bad address.
- **Non-base64 bytes / non-JSON body / oversize body.** `400` with a structured error body.
- **Underlying sign closure fails.** `500` with a structured error; the failure cause is logged
  through the captured supervisor context.
- **Unknown protocol path** (including any declared-but-unimplemented fork-control routes).
  Catch-all `404`. The redesign should not carry declared-but-unimplemented constants.
- **Scope closes mid-sign.** Keep-alive sockets are dropped immediately; the in-flight Effect runs
  under the supervisor context rather than the wallet's own scope and may complete after the wallet
  closes. Whether this should be cancelled is an open question.
- **Stale Node without `closeAllConnections`.** The current implementation optional-chains the call.
  The redesign can require a Node baseline that always has it and drop the guard.

## Learnings from current implementation

- Persisting the token across warm starts and snapshot restores is the right default. Without it,
  every supervisor restart invalidates the browser pairing and forces a re-pair UX, brutal during
  iteration.
- Capturing the supervisor's fiber context before listening is a load-bearing observability
  invariant that's easy to regress. Sign handlers run as detached async fibers; without the captured
  context they don't reach the TUI log sink or the trace pipeline.
- "Origin always required" closes the bypass that bearer-only auth leaves open. Not redundant with
  bearer — structurally necessary to keep non-browser tooling out of the signing path.
- Asymmetric response field names across sign endpoints (`{ suiSignature, txBytes }` vs
  `{ signature, bytes }`) and dual field-name acceptance for personal-message input are accidental
  complexity. The redesign should pick one shape; no migration burden.
- Declared-but-unimplemented protocol paths (fork-control) that fall through to the generic 404 are
  a half-done state.
- The wire protocol mirrored between devstack and the browser-side adapter is duplication forced by
  a workspace dependency cycle. A small third package owning the constants is the natural fix.
- The token file is not a state-store record (reasonable given the file-mode requirement) but the
  persisted artifact is invisible to "what does this plugin persist?" introspection.
- The manifest carries the unredacted pair URL with the token in the fragment, while the token file
  is mode `0o600` and the manifest is not — either tighten manifest perms or stop carrying the token
  inline.
- Two near-identical option types with a translation fold between them have never drifted; the
  redesign can collapse them.
- Hardcoded fallback ports for entrypoints when the registry should be authoritative are dead
  defensive coding.
- Stale JSDoc on bind-address default needs reconciliation; the security-hardened default should be
  the only documented default.

## Cross-component references

- **Identity / engine core** — supplies the app/stack/network triple for hostname composition and
  the canonical token path.
- **Engine resources (port allocator, state-store config, atomic write, service paths)** — port
  lifecycle, persistence-root resolution, durable token write.
- **Observability / supervisor context** — the captured fiber context replayed inside every async
  handler.
- **Runtime / Docker (router)** — entrypoint name lookup, hostname and router-id composition,
  file-provider YAML write/remove.
- **Runtime / endpoint registry** — publication of the canonical wallet endpoint that the manifest
  writer projects into `app.wallet.{url, pairUrl}`.
- **Sui service** — yielded for ordering (no field consumption).
- **Account component** — the only source of `Account` values; their sign closures are the wallet's
  actual signing capability.
- **Manifest emit** — projects the wallet endpoint into the on-disk manifest.
- **Codegen** — emits the dapp-kit config that constructs the browser-side adapter from the
  manifest.
- **Browser-side adapter package (`dev-wallet`)** — the wallet-standard surface the dApp sees
  through dapp-kit. Mirrors the protocol path constants; reads token off the pair URL fragment.
- **Vite plugin** — owns the in-page panel UI hosting the adapter, loads the manifest, and is the
  only consumer of dapp-kit / wallet-standard types.
- **Wipe command** — removes the per-stack state directory including the token file.

## Open questions / decisions deferred

- **Web UI at the wallet port?** Today the wallet port is API-only and the in-page UI lives at the
  vite origin. Confirm the redesign keeps this separation and does not plan a paired-wallet UI at
  the wallet port itself.
- **Cancellation of in-flight signs when the wallet scope closes.** Current behavior detaches the
  sign Effect under the supervisor context so it may complete after the wallet body closes. Decide
  whether the redesign should explicitly cancel pending signs on teardown.
- **Cross-stack pairing through `http://localhost:<vite-port>` in the auto-allowlist.** That origin
  is not stack-scoped, so a sibling stack's vite on the same port could pair with this wallet.
  Decide whether this is intentional or a security gap to close.
- **Fork-control protocol surface (status, advance clock, advance checkpoint, impersonations).**
  Decide whether the redesign ships them or drops the path constants entirely until ready.
- **Canonical response field shape across sign endpoints.** Pick one pair (e.g.
  `{ signature, bytes }`) for both endpoints; drop the dual field-name acceptance for
  personal-message inputs.
- **Token side-channel vs in-manifest delivery.** Decide whether the manifest continues to carry the
  pair URL with the token inline (with manifest permissions tightened) or the manifest carries only
  the URL and the token is fetched out-of-band from the side-channel file.
- **State-store integration for the token.** Decide whether to bring the token under the state-store
  taxonomy or formally document its exclusion.
- **Version negotiation route.** Today schema drift is caught only at devstack build time via a
  byte-equality coherence test. Decide whether the redesign exposes a version probe so a long-lived
  browser tab can detect mismatch against a freshly-deployed server.
- **CORS preflight scope.** Today OPTIONS handling runs before the path-prefix gate. Decide whether
  the redesign tightens preflight to the protocol prefix only.
- **Pairing invalidation surface.** Today a malformed token file is silently re-minted and any prior
  browser pairing breaks with no notification. Decide whether the redesign exposes a signal.

## Opportunities noticed

- Collapse the two near-identical option types into one caller-facing shape; the translation fold is
  pure overhead.
- Hoist the wire-protocol path constants into a tiny third package shared by devstack and the
  browser-side adapter to eliminate the byte-equality mirror.
- Pick one canonical response field shape for both sign endpoints and one request field name for
  personal-message input.
- Either wire the fork-control routes or remove their declared path constants —
  declared-but-unimplemented paths are exactly the "compat for never-cases" pattern the project
  repudiates.
- Surface the wallet token through the persistence taxonomy so introspection finds it.
- Tighten manifest permissions or drop the token from the manifest pair URL altogether, since the
  side-channel token file is already the more conservatively-protected source of truth.
- Replace the hardcoded vite-port fallback with a strict registry read.
- Reconcile the stale bind-address JSDoc to match the security-hardened default.
- Centralize the "upstream-keys for an account-yielding service" pattern via a small helper.
- Pin a test that the file-provider write is fail-open to document the one place in the boot path
  that does not fail boot on error.
- Cover both fragment and query forms in the token redactor so a future flip to a query-param token
  would not silently leak.
- Consider not carrying the unredacted pair URL on the resolved tag value at all — callers could
  reconstruct it from local port plus side-channel token — to remove a leakage vector.
