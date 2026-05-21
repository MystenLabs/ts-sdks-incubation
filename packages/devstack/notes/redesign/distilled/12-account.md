# 12 Account (distilled)

## Purpose

Account is the named-identity layer for devstack. For each named account in a stack, it acquires a
keypair (or a signer-shaped value), derives a Sui address, optionally funds it, registers
`{name, address}` so codegen and the manifest can surface it, and yields a resolved per-account
value carrying sign/execute capabilities. It is the canonical "give me a signer named `X`" primitive
consumed by package publish, action, wallet, deepbook market maker, etc.

Account is a thin driver. It produces no endpoint, no container, no routes. All of its value flows
from the Sui primitive plus an optional Faucet — it is downstream of both.

## Variants

Two axes interact: SOURCE (where the secret/signer comes from) and Sui RUNTIME (which network shape
is ambient). The runtime modulates the default-ephemeral source.

Six SOURCE variants:

- **ephemeral-funded (default for the bare form)** — generate or recover an Ed25519 keypair locally,
  persist the secret under the stack's runtime tree, and auto-fund the resulting address. The "fast
  inner loop" account for localnet and fork dev. Survives warm restarts; wiped by stack wipe.
- **keystore** — read an existing entry from a Sui-CLI-shape keystore (default location is the
  user's home, override allowed) by alias or by address. Devstack never copies the keystore; it only
  reads. The intended path for production and external-signer workflows where the user already owns
  the secret.
- **env** — read a bech32 secret from a user-named environment variable. Same intent as keystore but
  scoped to CI / vault-injected configurations.
- **inline** — accept a literal bech32 secret in config. Intended for tests and short-lived demos.
  Carries no persistence of its own.
- **signer** — accept a caller-constructed signer-shaped value directly (with an optional
  caller-supplied address override). The escape hatch for hardware wallets, custom KMS adapters, and
  dApp-side signers.
- **impersonate** — execute as a real on-chain address without holding its key. Only meaningful when
  the ambient Sui is in fork mode; the impersonation submit path replaces the normal signed-execute
  pipeline. Sign-individual-message surfaces deliberately fail loudly so callers cannot bypass the
  executor.

The bare/no-options form is shorthand for ephemeral-funded. On fork-runtime Sui, ephemeral-funded
silently auto-promotes from "faucet POST" to "pay-from-seed-via-impersonate" because no faucet
exists on a fork.

All variants share a cross-cutting funding capability — a name→amount or list-of-{coin,amount}
description dispatched through the ambient Faucet at acquisition. It is a noop when no Faucet is in
scope.

## Responsibilities

- Validate the account name against a strict charset; the name flows into a tag id, a filesystem
  path, a manifest key, and container labels.
- Resolve a signer or impersonation slot per the source discriminator.
- Persist locally-generated keypairs under the stack's runtime tree with restrictive permissions;
  recover them on warm restart.
- Derive and normalize the Sui address and the lowercased signature scheme.
- Drive the default funding path appropriate for the ambient Sui runtime (faucet POST on
  bundled/external; pay-from-seed-via-impersonate on fork).
- Apply the cross-cutting funding description by dispatching through Faucet (best-effort, by
  design).
- Register `{name, address}` in the account registry so the manifest and codegen can emit it.
- Provide sign-and-execute, sign-transaction, and sign-personal-message capabilities for the
  resolved identity, with per-address serialization to avoid gas-coin races.
- Wait for the chain to be "funds-transferable" before any first faucet POST, and wait for
  transaction finality after submit so follow-up references don't race the indexer.
- Narrate progress through the observability surface used by the TUI.

## Lifecycle states

Per-account states the body progresses through (in order, branched by source):

- pending — body is gated on Sui readiness (and any cited coin references).
- acquiring-signer — loading keystore / decoding env / reading inline / binding signer / binding
  impersonation slot, or generating-or-recovering an ephemeral keypair.
- address-resolved — address known; per-address lease is bindable; span attributes stamped.
- awaiting-chain-ready — only for ephemeral-funded on non-fork; blocks until the chain is
  funds-transferable.
- funding-default — drips from faucet OR transfers from a seed via impersonation, depending on
  runtime.
- funding-cross-cutting — dispatches each declared coin/amount through the ambient Faucet (noop if
  absent).
- registered — registry write landed; address is visible to the manifest/codegen.
- ready — resolved value produced; sign/execute closures are live.

There is no separate health-check or external probe; the account is a value-producer, not a
long-lived server. There is no custom teardown — closures live for the surrounding scope, persisted
secrets survive until stack wipe.

## Inputs / dependencies

Hard upstreams (must be ready before the body can run):

- Sui (network, runtime mode, optional faucet handle, optional fork handle, client, "wait for
  transactions ready" gate).
- Any cross-cutting funding entry that references a coin-typed handle (those handles must resolve
  first).

Soft/optional upstreams (consumed when present, silently skipped otherwise):

- Faucet — used for the cross-cutting funding pass. Absence is treated as a noop, not a failure, to
  keep test ergonomics intact.

Engine-level resources (provided by infrastructure, not the stack):

- Per-address lease/semaphore used to serialize sign-execute work on the same address.
- Filesystem access for ephemeral-keypair persistence and keystore reads.
- State-store-derived runtime root path resolution (drives where the persisted key file lives).
- Account registry for the `{name, address}` publish.
- Faucet helper for the SUI-faucet POST path.
- Tagging / phase-narration helpers for observability and TUI integration.

External:

- The chain itself (gRPC sign-and-execute, transaction-finality wait).
- The fork's impersonation endpoint (fork-runtime funding and impersonation-source execution).
- The user's keystore file and the user's process environment for the keystore/env sources.

## Outputs / capabilities provided

Per-account resolved value (consumed by other components):

- Name, address, lowercased scheme.
- Public-key bytes — caveat: a zero buffer for impersonation accounts; the source discriminator is
  the trustworthy signal.
- Source discriminator (real vs impersonate).
- Sign-and-execute capability — single entry point, per-address-serialized, post-submit
  transaction-wait included, bounded retry on the "dependent package not found on-chain" race.
- Sign-transaction and sign-personal-message capabilities — real signers honor these; impersonation
  accounts deliberately throw on direct sign calls so callers cannot bypass the executor.

Registry / artifacts:

- `{name, address}` published to the account registry (dedup by name, last-write-wins).
- Manifest entry per resolved account so external tools and codegen can read addresses post-run.
- An on-disk bech32 secret file for ephemeral-funded accounts under the stack's runtime tree
  (restrictive permissions; tarred into snapshots).

Observability:

- Per-account span scoped to the acquisition, with attributes naming the account, source, runtime,
  and resolved address.
- Phase narration to the TUI (loading keystore, binding signer, binding impersonation slot,
  fork-impersonate funding, awaiting chain funds-transferable, requesting funds, per-coin funding
  messages, retry-progress messages).

## Invariants and constraints

- **Name shape**: strict alphanumeric + `._-`, leading alphanumeric, length-bounded. The name is
  load-bearing across the tag id, on-disk path, manifest key, and container label; broader charsets
  would let typos traverse directories or break label parsing.
- **Concurrent first-time keypair persistence**: must use an exclusive-create write. Two parallel
  generators must not both win; the loser must fall back to reading the winner's persisted key.
- **Restrictive file permissions**: secret file 0o600, parent dir 0o700. Re-tightened on warm-start
  to repair older permissive writes; best-effort on platforms that don't honor POSIX modes.
- **Scheme normalization**: scheme surfaced to consumers must be lowercased at the account boundary.
  Mixed-case from the SDK leaks into manifest serialization and on-chain Move type matching if not
  converted.
- **Chain-ready gate before first faucet POST**: ephemeral-funded on non-fork must wait for the
  chain to be funds-transferable before any faucet drip. The gate is centralized on Sui (memoized)
  so parallel accounts share one resolution.
- **Per-address sign serialization**: two parallel sign-and-execute calls from the same address must
  serialize; otherwise the gas-coin version races and one fails with a locked-shared-object error.
- **Post-submit transaction wait**: every sign-and-execute path must wait for finality so follow-up
  transactions referencing newly-created objects don't race the indexer. A short bounded retry on
  the corresponding gRPC race-error is also required.
- **Impersonation only on fork**: the impersonation source must refuse outside fork-runtime.
- **Fork-runtime ephemeral funding requires seed addresses**: a fork has no faucet; absent seeds it
  must fail with a clear pointer at the seed-configuration surface.
- **Ephemeral-funded on non-fork requires a faucet**: absence must fail with a clear pointer at the
  keystore/env/inline alternatives, not at a generic "missing service".
- **Upstream declarations must be strict**: the body must declare Sui as a hard upstream and add any
  funding-handle references; Faucet is intentionally optional.
- **Optional Faucet is a noop, not an error**: an account declaring cross-cutting funding without a
  Faucet in scope must silently skip — this is a test-ergonomics contract.
- **Bare form equals ephemeral-funded**: the bare/no-options shorthand is identical to the explicit
  ephemeral-funded form. No alternative default.
- **Acquisition vs signing error split**: acquisition failures (faucet drained, keystore unreadable,
  decode failed) must surface as a typed account error; signing failures (gRPC error, tx-failure,
  finality-wait failure) must surface as the sign/execute error type. Mixing the two breaks
  downstream catch-by-tag.
- **Sign-and-execute is the only execution surface for impersonation**: synthetic impersonation
  signers must throw synchronously on direct sign calls so accidental bypass is loud, not silent.

## Edge cases and known failure modes

- Invalid name — surface synchronously at the factory boundary; do not let it reach the body.
- Keystore missing, malformed, empty, or alias-not-found — typed acquisition error with a message
  naming the path and what was attempted.
- Env-var missing or empty — typed acquisition error naming the var and the account.
- Bech32 decode failure — typed decode error.
- Unsupported signature scheme (multisig / zklogin / passkey) — currently a raw throw; should be
  promoted to the typed-error channel.
- Persistent faucet failure (timeout or exhausted attempts) — typed funding error with a pointer to
  the faucet host.
- Chain never becomes funds-transferable — typed funding error attributing the abort to chain
  readiness.
- Ephemeral-funded on a network with no faucet — typed funding error pointing at the
  keystore/env/inline alternatives.
- Cross-cutting funding entry fails (no strategy / strategy errored) — typed funding error naming
  the coin type and amount.
- Sign-and-execute fails (gRPC, tx-failure, finality wait) — sign/execute error; the "dependent
  package not found on-chain" subcase is retried briefly before surfacing.
- Direct sign call on an impersonation account — synchronous throw with a message naming the bypass.
- Fork-runtime with no seed addresses — typed funding error pointing at the seed config.
- Impersonation source outside fork-runtime — typed funding error pointing at the runtime
  requirement.
- EXCL-write race for first-time persistence — automatic; the loser reads the winner's persisted
  key.

## Learnings from current implementation

- Centralizing the chain-ready gate on Sui (memoized) is critical — multiple parallel accounts would
  otherwise each burn their own retry budget. The redesign must preserve this single-point gate.
- Per-address lease around sign-execute is non-negotiable; gas-coin races otherwise surface as
  confusing locked-shared-object failures.
- Post-submit finality wait is required for the publish→subsequent-moveCall pattern; without it the
  second tx flakes with "dependent package not found".
- The exclusive-create write for the persisted keypair is load-bearing under concurrent first-time
  acquisition.
- The funding pass is intentionally optional-Faucet-tolerant so unit tests don't have to mount
  Faucet. This is a deliberate ergonomic decision, not an oversight — the redesign should keep the
  soft-dependency shape.
- The bare-form auto-promotion to fork-impersonate funding when Sui is in fork mode is an
  undocumented silent behavior change for the user; the redesign should make this discoverable.
- Cross-cutting funding currently dispatches serially. Latency dominates per-account cold-start for
  stacks declaring many coin types.
- Persistence currently bypasses the typed-state-store-keys registry, which is the convention for
  every other persisted artifact in the package. Snapshot save/restore happens to cover it
  (runtime/-rooted tar), but invalidation semantics are not co-located.
- The mixed-case scheme bug-fix is fragile scar tissue; the conversion belongs closer to the SDK
  boundary or in the canonical Account type definition.
- The impersonation account's zero-buffer public key is a type-level lie; consumers that treat
  publicKey as authoritative will silently misbehave on impersonation accounts.

## Cross-component references

- **Sui**: hard upstream. Account reads runtime mode, faucet handle, fork handle, client, and the
  chain-ready gate from Sui. Auto-promotion of ephemeral-funded depends on Sui runtime.
- **Faucet**: soft upstream. Account dispatches all cross-cutting funding through Faucet. Faucet's
  per-coin strategy registration determines what funding entries are accepted.
- **State store / runtime paths**: drives where the persisted keypair file lives. Account is the
  only persistent service that currently bypasses the typed-keys registry convention.
- **Registries (account registry)**: Account writes the `{name, address}` record; the manifest
  emitter and codegen read it.
- **Leasing**: provides the per-address semaphore around sign-execute.
- **Engine tag/phase/observability**: Account uses the tagging primitive, phase narration, and span
  annotation surfaces.
- **Package**: consumes the resolved account as the publishing signer.
- **Action**: consumes the resolved account as the action sender.
- **Wallet**: consumes a list of resolved accounts to materialize a wallet panel.
- **Deepbook market maker**: consumes a resolved account as the maker identity.
- **Codegen (stack-handle emitter)**: emits a constant address map keyed by account name.
- **Snapshot**: covers the persisted keypair file because the snapshot tar is runtime-rooted.
- **Fork helpers (impersonation executor, default fork gas budget)**: Account routes impersonation
  execution through these.

## Open questions / decisions deferred

- Should the persisted keypair file move into the typed-state-store-keys registry alongside every
  other persisted artifact, or be carved out as a documented exception?
- Is there a need for a wipe-single-account surface, or is "wipe the whole stack" the only
  invalidation contract worth supporting?
- Should warm-start short-circuit the default funding step when the persisted address already has a
  positive balance, or keep the always-fund behavior and rely on the faucet's own idempotence?
- Is the optional-Faucet path actually exercised in production or only in tests? If the latter, the
  production codepath could be allowed to depend on Faucet strictly.
- Should the per-account span and the phase narration be unified into a single observability surface
  so they don't drift?
- Should cross-cutting funding dispatch concurrently when the faucet strategies are concurrent-safe,
  gated by a per-strategy flag?
- Is the seed-address selection policy for fork-runtime ephemeral funding "first seed wins"
  intentional, or should it round-robin / fan-out across seeds?
- Should the impersonation account's resolved value expose a different shape (no `publicKey`,
  mandatory `source` discriminator) so consumers cannot accidentally treat it as a real signer?
- Should the unsupported-signature-scheme path become a typed acquisition error to unify the error
  surface?

## Opportunities noticed

- Collapse the three places that document the on-disk persistence path; only one of them currently
  matches the implementation.
- Co-locate the canonical Account-value Schema with the canonical type rather than next to the
  factory, to prevent drift.
- Promote the sign/execute error to the same tagged-error class shape as the acquisition error so
  the engine's pretty-cause walker handles it uniformly and the JSON-projection special case can go
  away.
- Move the synthetic impersonation signer next to the other fork-only helpers (impersonation
  executor, default gas budget) — keeps fork specifics together and shrinks the account driver.
- Replace the stale engine-level comment that refers to a never-built composite "accounts({...})"
  factory with a description of the actual per-name factory pattern.
- Document the snapshot-portability implication of the persisted keypair file at the Account level,
  not only at the runtime-tar contract.
- Make the bare-form auto-promotion to fork-impersonate funding discoverable from the factory
  signature/docs, not only from a deep code comment.
- Add a seed-address fan-out policy (round-robin or random) for multi-seed fork configurations so
  one seed doesn't run dry first.
- Drop the dead "kindOmitted" branch left over from a partially-landed change.
- Tighten the resolved-account type (drop the optional on the source discriminator; reflect the
  impersonation publicKey caveat in the type) — the package is unreleased, no compat shim warranted.
