# 11 Faucet (distilled)

## Purpose

The faucet subsystem is devstack's centralized **coin-funding facade**: a single dispatch point
that, given a coin type, a recipient address, and an amount, hands the recipient that coin. Behind
that one entry point sit multiple **strategies**, each knowing how to deliver one specific coin via
one specific mechanism (HTTP faucet POST, on-chain Move call, treasury-cap mint, …).

The faucet itself is **not a process, container, or socket**. It is a thin in-memory dispatcher
whose strategies wrap external resources owned by other primitives (sui-localnet's embedded
`sui-faucet` HTTP server, walrus's published exchange object, package-published treasury caps). The
mental model: "a typed mutable map of coin → strategy, plus an `Effect.serviceOption` consumed by
sibling primitives to register themselves."

It is auto-mounted on every stack so any consumer can always find a registered strategy without the
user having to type it.

## Responsibilities

- Own the **strategy registry**: a per-cycle, scope-local map from coin type to strategy, with
  last-write-wins overwrite semantics.
- **Auto-register the SUI HTTP strategy** when the in-scope Sui has a faucet URL; do nothing when it
  doesn't (mainnet, fork, custom-without-faucet).
- **Dispatch** a `(coinType, address, amount)` request to the right strategy, raising a typed error
  naming the registered set if no strategy matches.
- Expose a **listing** of currently-fundable coin types for downstream surfaces (TUI / manifest).
- Provide a **strategy interface** that sibling primitives (Walrus, Package, plugin authors) use to
  slot their own per-resource funding mechanism in.
- Provide a **retry-with-jitter HTTP client** sized for warm-up races, used by the built-in SUI HTTP
  strategy and reusable by other HTTP-faucet strategies.
- Stay quiet in the dashboard when auto-mounted; show up as a visible row when the user supplied it
  explicitly.

## Strategy-registry pattern

A strategy-registry conceptually has three parts:

1. A **capability key** — here, the coin type. The key is what callers ask for ("give me X").
2. A **strategy interface** — a small, closed contract (coin type tag + a `request(address, amount)`
   effect). Strategies close over their own dependencies at construction time (signer account,
   exchange object, treasury cap) so the dispatch site sees a uniform shape with no extra context
   requirements.
3. A **scope-local registry** — a per-layer-build mutable map, populated during the acquire phase by
   the faucet's own auto-registration plus sibling primitives registering themselves via
   `Effect.serviceOption`. Registries in different stacks (parallel `devstack` runs in the same
   process) are disjoint by construction.

**Selection rule**: dispatch by capability key only. The user's network mode (localnet vs testnet vs
mainnet vs fork) does NOT select between strategies at dispatch time — instead, it determines which
strategies _get registered_ in the first place. SUI HTTP only auto-registers when the Sui in scope
has a faucet URL. WAL exchange only auto-registers after Walrus publishes its exchange.
Treasury-cap-mint only auto-registers after a Package publishes a coin. Mode shapes the
**population** of the registry; the dispatcher itself is mode-agnostic.

**Override rule**: caller-supplied strategies register _after_ built-ins, so users can replace a
built-in by listing one with the same capability key. Last write wins.

**Generalization**: the same pattern fits anywhere devstack offers "multiple ways to deliver X,
available conditional on what else is in scope":

- A future codegen subsystem with multiple renderers selected by source kind.
- A wallet/signer registry where some accounts come from keystore, some from environment, some
  impersonated on a fork.
- A snapshot store with local-disk, S3-backed, or Walrus-backed variants. The load-bearing
  properties are: scope-local registry, capability-keyed dispatch, sibling primitives
  self-registering via `serviceOption` so the strategy provider and consumer never need a direct
  dep-graph edge, and mode determining population rather than dispatch.

## Lifecycle states

- **Constructed**: the registry layer is built synchronously; the in-memory map exists, empty. No
  external readiness probe.
- **Built-in populated**: if Sui is in scope and has a faucet URL, the SUI HTTP strategy registers
  itself against the resolved (routed) faucet host. If Sui has no faucet (mainnet, fork), nothing
  registers under "SUI".
- **User-populated**: caller-supplied strategies from the faucet factory's options run after
  built-ins, overriding as needed.
- **Sibling-populated (in-cycle)**: during the cycle's acquire phase, Walrus registers its WAL
  exchange strategy once its exchange object resolves; Package registers a treasury-cap-mint
  strategy per published coin. These happen sequentially inside each sibling's acquire body.
- **Dispatching**: callers (Account funding loops, plugin code) ask for
  `(coinType, address, amount)`; the dispatcher finds the strategy and runs it. Strategies that go
  over the wire (SUI HTTP) carry their own retry/timeout schedule; on-chain strategies (mint,
  exchange) do a single signed tx and surface errors directly.
- **Teardown**: synchronous GC of the in-memory map when the surrounding scope closes. No sockets,
  files, or children to clean up. The downstream `sui-faucet` HTTP server inside the Sui container
  tears down with that container.
- **Restart (warm re-up)**: the registry is rebuilt fresh from scratch each cycle. Nothing persists.
  Sibling primitives re-register from their own re-resolved cached state (Walrus re-resolves
  exchange object, Package re-resolves treasury caps).

## Inputs / dependencies

- **Sui (optional, runtime-read)**: read via `Effect.serviceOption` at acquire to discover the
  routed faucet host URL. The optional yield means the faucet layer builds successfully even with no
  Sui in scope (e.g., unit tests, mainnet stacks). Faucet declares NO upstream dependency on Sui in
  the dep graph — it is a true leaf.
- **A funds-transferable barrier** owned by Sui: consumers must wait for Sui's expensive real-tx
  ready probe (which POSTs to the faucet against a stable throwaway address and checks for
  body-level success) before issuing their first funding request. This barrier is shared and
  memoized so parallel consumers spend one wall-clock budget, not N.
- **Per-strategy resources**: the WAL strategy closes over an exchange-object handle and an admin
  signer; the treasury-cap-mint strategy closes over a TreasuryCap and a signer Account. These are
  passed at strategy _construction_ time; the dispatch site needs nothing extra.
- **HTTP fetch + AbortSignal**: the SUI HTTP strategy is the only devstack subsystem (besides Sui's
  own probes) that talks directly to a remote HTTP endpoint without going through a docker/host
  abstraction.
- **No filesystem, no subprocesses, no port leases, no locks** of its own.

## Outputs / capabilities provided

- A **dispatch capability** keyed on coin type: a single call to "give address X amount Y of coin Z"
  that succeeds or raises a typed error.
- A **registration capability** for siblings and plugin authors: idempotent overwrite by coin type.
- A **listing of currently-fundable coin types** for surfaces that want to render "what can this
  stack hand out right now."
- A **strategy interface** for plugin authors (one of the smallest, cleanest plugin surfaces in
  devstack).
- A **shared retry-with-jitter HTTP helper** sized for warm-up races (bounded wall-clock budget,
  exponential backoff, per-fetch deadline short relative to the budget, jitter to avoid
  thundering-herd retries from concurrent accounts).
- A **typed error class** carrying coin type, address, amount, and an inner cause, suitable for
  pretty-error rendering and structured catch boundaries.

It does NOT produce: an endpoint, a state-store entry, an event bus message, a file on disk, a CLI
command, a routed port, or a container image.

## Invariants and constraints

- **Registry is scope-local, never module-level.** Parallel stacks in the same process must hold
  disjoint registries; module-level state would silently mis-fund across stacks.
- **Auto-mounted faucet is hidden in the TUI**; user-supplied faucet is visible. Auto-included infra
  the user didn't type shouldn't claim dashboard real estate.
- **SUI HTTP strategy auto-registers only when an upstream faucet URL is known.** On mainnet (or any
  Sui without a faucet), no SUI strategy exists; ephemeral-funded accounts fail fast at acquire-time
  with an actionable error rather than at first POST.
- **Re-registering overwrites (last write wins).** Tests stub built-ins this way; user overrides
  depend on it.
- **Faucet layer requires NO upstream context.** Auto-mount must succeed on any stack regardless of
  what else is present.
- **Strategies' context channel resolves to `never` at the registry boundary.** Strategies close
  over their own dependencies at construction; the dispatch site is context-free.

Wire-level invariants for the SUI HTTP strategy (each crystallized through a specific bug fix):

- A **non-2xx HTTP status MUST raise**, not be treated as success. (Sui's faucet binds its HTTP
  socket before the validator can transfer coins; that window returns 5xx.)
- A **200 OK body with a "Failure" status MUST raise.** This is the most load-bearing assertion:
  during warm-up the faucet accepts requests it cannot execute (gas object stale, mid-genesis);
  treating those as success marks accounts funded when no coins moved.
- **Per-fetch deadline is short relative to wall-clock budget** (default 5s vs 90s). The faucet's
  internal retries can block one POST for ~60s; capping per-fetch lets the outer retry loop hammer
  quickly and land on the first attempt after the chain catches up.
- **Retry MUST jitter.** Pre-jitter, parallel accounts retried on the same wall-clock tick and
  thundering-herded the faucet.
- **First faucet POST MUST follow a shared funds-transferable barrier** owned by Sui. The barrier is
  keyed off the faucet URL specifically: no faucet URL means no barrier (mainnet,
  custom-without-faucet — by design).
- **Per-strategy zero-amount semantics are explicit**: minting zero is a no-op (the Move call may
  fail or produce dust events); WAL exchange with zero falls back to a default payment.
- **The WAL strategy's `amount` parameter is denominated in the payment coin (SUI MIST), not the
  received coin (WAL units).** The Move signature is "spend X, receive whatever the rate gives you";
  this is footgunny enough to document at the interface level.

## Edge cases and known failure modes

- **`fetch` rejection (ECONNREFUSED / DNS / TLS)**: typical during cold boot before the faucet HTTP
  server binds. Wrapped and retried inside the wall-clock budget.
- **HTTP non-2xx (commonly 503)**: warm-up window where the socket is bound but the validator isn't
  transferable. Wrapped and retried.
- **HTTP 200 with body-level Failure**: the load-bearing case. Faucet accepted the request but
  couldn't execute the underlying tx. The shared funds-transferable barrier is designed to make
  these rare after the first one; if they recur, the retry loop catches them.
- **JSON parse failure on a 200 body**: extremely unusual; would indicate an upstream bug or routing
  mis-hit. Retried though likely to recur.
- **Per-fetch deadline elapses**: a single POST hung past the per-fetch cap. Aborted and retried;
  the cap exists specifically to protect the wall-clock budget from being burned by one hung
  request.
- **Wall-clock budget exhausted**: every retry failed within the budget. Final error message
  includes attempt count and last cause; surfaces as account funding failure and fails the
  supervisor cycle.
- **Retry count exhausted before wall-clock budget**: a separate exhaustion path; same surfaced
  error class.
- **Unknown coin type at dispatch**: typed error naming the registered set. Common when a user
  requests `WAL` without a Walrus in scope, or requests a user coin without the Package that
  publishes it. Today's message doesn't distinguish "you never declared it" from "you declared it
  but ordering is wrong."
- **Sui has no faucet (mainnet, custom-without-faucet)**: ephemeral-funded account fails at
  acquire-time with a clear "use a non-ephemeral kind or pick localnet" message.
- **Chain never becomes funds-transferable**: the shared barrier itself exhausts its budget; usually
  means mid-genesis cold start or inconsistent on-disk state from a SIGKILL'd shutdown. Diagnostic
  names the wipe-and-retry recovery.
- **On-chain strategy signing failure** (WAL exchange, treasury-cap mint): the cap-holder signer's
  transaction failed (gas stale, network blip, cap stale). Wrapped as a typed funding error with
  coin/address/amount context; strategy does NOT retry internally — the outer consumer maps it to
  its own phase error.

## Learnings from current implementation

- **Two error paths exist for SUI funding today** — direct (account top-up calls the HTTP client
  directly) and registry (cross-cutting funding loop dispatches through the registry). The
  auto-registered SUI strategy is therefore dead code for the most common funding path. A v2 design
  that routes everything through the registry would eliminate this split.
- **The engine-side HTTP client and the service-side strategy are 1:1**: the SUI strategy is a thin
  error-mapping wrapper around the HTTP helper. The split exists because the helper landed first (as
  raw wire transport) and the registry was added later. Folding the helper into the strategy
  collapses two import paths, two error classes, and an indirection.
- **Two flavors of "auto-register a per-resource strategy"** exist (Walrus, Package), each
  implementing the same `serviceOption → build → register` pattern with subtly different
  skip-on-missing-context rules. A shared helper or a declarative "this primitive emits a strategy"
  convention would dedupe.
- **The "service" abstraction is heavier than the actual surface**: the FaucetTag interface is
  `register + dispatch + list`; the implementation is a typed mutable map. No concurrency control,
  fairness, rate-limiting, or metrics of its own. Worth questioning whether v2 keeps the full
  service framing or expresses the registry more directly.
- **Warm-up race mitigation is layered across three places**: Sui's cheap socket-level probe, Sui's
  expensive funds-transferable probe, the HTTP client's retry loop. Each was added at a different
  time to plug a different race. The layering works but the rationale could be more sharply
  documented or consolidated.
- **The retry profile (15 attempts, 90s budget, 500ms initial delay, 1.5x backoff, [0.8,1.2) jitter)
  is "warmup-friendly" and reused informally by other warm-up paths** (e.g., indexer-db readiness).
  Could be lifted into a named retry-profile abstraction.
- **`amount` means different things per strategy** (ignored for SUI, MIST for WAL, raw u64 for user
  coins). Documented at the interface but footgunny at the call site. A branded per-strategy unit,
  or always-coin-native-smallest-unit with explicit converters, would harden this.
- **The auto-mount visibility knob has effectively two values driven by two callers**, neither of
  whom typically sets it explicitly. Could be inferred from auto-mount context rather than typed.
- **`listFundable` appears to be JSDoc-documented for manifest emission but has no production
  consumer.** Either the manifest emitter never adopted it (forward-looking dead API), or the grep
  missed something. Resolving this determines whether it stays in the v2 contract.

## Cross-component references

- **Sui (`05-sui.md`)**: owns the upstream `sui-faucet` HTTP server (embedded in the localnet
  container) and the funds-transferable barrier. The faucet reads Sui's faucet URL via optional
  service yield. Sui's three-probe ready gate guarantees the socket is bound; Sui's expensive ready
  probe guarantees the tx pipeline is live.
- **Walrus (`06-walrus.md`)**: auto-registers the WAL exchange strategy post-deploy. WAL `amount`
  semantics (SUI MIST payment) come from the exchange Move signature.
- **Package (`14-package.md`)**: auto-registers a treasury-cap-mint strategy per published coin in
  `Package({ coins })`.
- **Account (`12-account.md`)**: primary consumer. The `ephemeral-funded` SUI top-up currently
  bypasses the registry and calls the HTTP helper directly. The cross-cutting `funding:` loop
  dispatches through the registry. Account also owns the shared barrier-wait before first POST.
- **Compose / defaults (`02-engine-resources.md` adjacent)**: auto-mounts a hidden faucet on every
  stack if the user didn't supply one.
- **Engine resources**: faucet uses the engine-wide retry / jitter / timeout / span helpers; no
  docker, no fs, no port lease, no lock.
- **Observability (`03-observability.md`)**: emits a span around the request flow with URL and
  address annotations; relies on Effect's default logger.
- **CLI (`20-cli.md`)**: faucet has no CLI surface. The Sui CLI wrapper sets `SUI_FAUCET_URL` for
  Move-build subprocesses — faucet-adjacent plumbing that may or may not need to remain.
- **Manifest (referenced from CLI)**: the Sui service renders its faucet URL as a service entry.
  Whether the v2 manifest carries per-coin "fundable" information driven by `listFundable` is an
  open question.

## Open questions / decisions deferred

- Does `listFundable` have any real production consumer, or is its JSDoc-documented
  manifest-emission role a never-shipped feature? Determines whether it stays in the v2 contract.
- Does the public testnet faucet honor the same request/response shape that the local `sui-faucet`
  binary uses? The funds-transferable barrier runs against any non-undefined faucet URL, including
  testnet, but real-network behavior is unverified. Relevant for whether the warm-up retry profile
  is sized correctly for live networks.
- Should the v2 design keep one faucet service with a coin-keyed registry, or split into per-coin
  tags each provided by its own layer? Today's single-registry choice optimizes for plugin-author UX
  (one register call from any context); the alternative may be cleaner for typing and dep-graph
  visibility.
- What's the right error shape when a user requests a coin that's not registered? Distinguishing
  "you never added the providing primitive" from "you added it but it hasn't run yet (ordering)"
  would improve user experience but requires the registry to carry intent / declarations beyond just
  registrations.
- Should the visibility knob exist at all, or be inferred from auto-mount context?
- Should the engine-side HTTP helper and the SUI HTTP strategy collapse into one module? Should the
  auto-mount path expose retry/timeout overrides today only available on the direct-call path?
- Should the SUI HTTP strategy share its retry profile and probing logic with Sui's cheap
  socket-level probe and Sui's expensive funds-transferable probe? They overlap conceptually but
  live in different modules.
- Where should `SUI_FAUCET_URL` env-var propagation live? Move builds typically don't need it; the
  current wide spawn-site emission is faucet-adjacent plumbing in the Sui CLI wrapper.

## Opportunities noticed

- **Generalize the strategy-registry pattern** as a first-class devstack primitive. Faucet is the
  clearest instance, but signer/keystore selection, snapshot backends, and codegen renderers all fit
  the same "capability-keyed, scope-local, sibling-self-registering" shape. The faucet's interface
  is small and clean enough to be the canonical example in plugin-author docs.
- **Make sibling auto-registration declarative**: rather than each sibling primitive (Walrus,
  Package) implementing the same `serviceOption → build → register` boilerplate, the sibling could
  emit "I provide these strategies" as part of its tag declaration, with the framework collecting
  and registering them.
- **Lift warm-up race mitigation out of per-call knobs into a composition pattern**: "first faucet
  POST happens after a single shared funds-transferable barrier" expressed as tag composition rather
  than as a retry-loop knob in each consumer.
- **Lift the warmup retry profile** (attempts × budget × backoff × jitter) into a named
  "warmup-friendly retry" abstraction reusable by other warm-up paths (indexer-db, walrus storage
  nodes, seal services).
- **Brand or schema per-strategy amount units** so the meaning of `amount` is type-visible at the
  call site rather than only in JSDoc.
- **Route ephemeral-funded SUI top-up through the registry** instead of the direct HTTP helper,
  making the auto-mounted SUI strategy load-bearing and eliminating the parallel error paths.
- **Consider a subscribable registry** so live-renders (dashboard, manifest) reflect mid-cycle
  strategy registration without polling.
- **Document or consolidate the three-layer warm-up mitigation** (cheap socket probe, expensive
  funds-transferable probe, retry loop). Each plugs a different race, but the layering rationale
  isn't co-located today.
- **Audit the engine-vs-service split** generally: faucet's engine/service split is mirrored in
  other primitives. The pattern may be appropriate for some (Sui's CLI wrapper) and overkill for
  others (a 1:1 helper → strategy wrap is just indirection).
