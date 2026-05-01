# Prior art: non-EVM blockchain dev tooling

Survey of dev harnesses outside the EVM mainstream, framed against the `@mysten-incubation/devstack`
design (see `docs/devstack-design.md`). The closest in-ecosystem prior art
(`MystenLabs/deepbook-sandbox`) is already cataloged as anti-pattern in CLAUDE.md and not
re-litigated here.

## 1. Solana — Anchor (the one we should study hardest)

**Config.** A single `Anchor.toml`: `[toolchain]`, `[features]`, `[workspace]` (`members`, `types`
output dir), `[programs.<cluster>]` (per-cluster program-id map), `[provider]` (cluster + wallet),
`[scripts]` (`anchor run <name>` shells out), `[test]` + `[test.validator]` (passes through to
`solana-test-validator`: `clone`, `account` JSON preload, `warp_slot`), `[hooks]` (pre/post
build/test/deploy, 1.0+). One file, no generated configs in tree.
([Anchor.toml](https://www.anchor-lang.com/docs/references/anchor-toml))

**Plugin / extension.** None as a first-class concept until 1.0. Anchor is monolithic —
`anchor init`, `anchor build`, `anchor test`, `anchor deploy` are baked-in commands. Extensibility
happens through (a) `[scripts]` for arbitrary shell-outs and (b) `[test.validator.clone]` for
pulling in mainnet programs. Anchor 1.0 (April 2026) added **lifecycle hooks** in `Anchor.toml` —
still not a plugin model, but a seam for pre/post build/test/deploy.
([Anchor 1.0 announcement](https://x.com/solana_devs/status/2039837963840803283))

**Generated artifacts.** Anchor's strongest move. `anchor build` emits an **IDL** (JSON:
instructions + accounts + events + types) at `target/idl/<program>.json` and a **typed TS client**
at `target/types/<program>.ts`. The IDL is uploaded _to-chain_ on `anchor deploy`, so any client can
fetch it and reconstruct the typed surface without source access. `[workspace].types` copies the TS
file to a user-specified path. ([IDL docs](https://solana.com/docs/programs/anchor/idl))

**Multi-service local dev + isolation.** `anchor test` spins `solana-test-validator` (1.0:
**Surfpool**, which can clone mainnet state on demand), runs tests, tears down.
`[test.validator.clone]` pulls arbitrary accounts/programs from mainnet-beta into the local
validator at startup — the "fork-from-mainnet" story. Pre-1.0 inner loop: 5–10s validator restart
per `anchor test`. Anchor 1.0 makes **LiteSVM the default test template** — in-process VM, tens of
milliseconds per test, no chain process. Bankrun is the JS-side equivalent.
([Bankrun](https://kevinheavey.github.io/solana-bankrun/tutorial/),
[LiteSVM](https://www.anchor-lang.com/docs/testing/litesvm))

## 2. Solana — solana-test-validator + Bankrun

The design point worth calling out separately is the **`--clone` family**: `--clone <ACCOUNT>`,
`--clone-upgradeable-program <ID>`, plus a feature gate that makes the local validator behave like
an arbitrary cluster slot. `--reset` blows away state. Bankrun loads programs from `.so` directly
into an in-process VM and exposes a `BanksClient` that looks like an RPC client but never opens a
socket.
([solana-test-validator](https://solana.com/developers/guides/getstarted/solana-test-validator),
[Bankrun + Jest](https://solana.com/developers/guides/advanced/testing-with-jest-and-bankrun))

## 3. Cosmos — Ignite CLI (formerly Starport)

**Config.** `config.yml` at chain root: `accounts[]` (named keypairs with `coins`), `validators[]`,
`faucet`, `build`, `genesis`, `init`. `include` directive splits overrides into multiple files.
([Ignite config](https://docs.ignite.com/configuration/config))

**Plugin / extension.** `ignite scaffold chain|module|message|query|type` generates a full
Cosmos-SDK chain skeleton. Ignite **does** ship a plugin system (called "apps") — community plugins
hook into the CLI surface itself. The closest analogue in non-EVM land to a real plugin marketplace.

**Generated artifacts.** `ignite generate ts-client` emits a typed TS client per module off
protobuf; `ignite generate openapi` emits an API spec. Driven by the chain's protobuf — single
source of truth.

**Multi-service local dev.** `ignite chain serve` starts chain + faucet

- REST/gRPC. No native multi-chain orchestration; IBC relayer is a sibling `ignite relayer` command.
  Test isolation: Cosmos-SDK's `simapp`, not an Ignite-specific harness.

## 4. CosmWasm — Beaker (Osmosis)

**Config.** `Beaker.toml` with `[global]`, `[workspace]`, `[wasm]` (`contract_dir`,
`optimizer_version`, `template_repos`), `[console]`. `.beaker/state.json` tracks per-network code
IDs and contract addresses across deploys.
([Beaker config](https://github.com/osmosis-labs/beaker/blob/main/docs/config/README.md))

**Plugin / extension.** **Rhai-scripted tasks**, not a typed plugin contract. `beaker task <name>`
runs a Rhai script with access to `wasm::deploy()`, `wasm::execute()`, `wasm::query()`,
`fs::open_file()`, plus helper macros. Trade-off: cheap to expose the whole CLI in an embedded
script language, but loses typing entirely.

**Generated artifacts.** Beaker leverages **`ts-codegen`** (CosmWasm's contract → TS client
generator) — generated clients carry raw `execute`/`query` plus convenience methods per message
variant (e.g. `sc.increment()`).

**Multi-service local dev.** Beaker explicitly does _not_ manage LocalOsmosis — you run LocalOsmosis
separately and Beaker talks to it via `--network`.

**Console.** The single most novel feature: an interactive Node REPL with `contract` and `account`
namespaces pre-bound to deployed contracts and signers — `.deploy`, `.build`, `.execute` as REPL
commands. We have nothing like it; the `endpoints()` banner is much weaker.

## 5. Aptos / Move-related

**Config + CLI.** `aptos move {compile,test,publish,run}` against a `Move.toml` very similar to
Sui's. There is **no formal Aptos equivalent of deepbook-sandbox or scaffold-eth**. Local node is
`aptos node run-local-testnet`.
([Aptos CLI](https://aptos.dev/build/cli/working-with-move-contracts))

**Generated artifacts.** No first-party codegen. **Surf** (Thala Labs) is the de-facto solution —
and it does the _opposite_ of `@mysten/codegen`: TypeScript inferred types over the JSON ABI, no
codegen step. Pros: zero build step, types update when ABI updates. Cons: large inferred types
stress the TS server; can't ship a published `.d.ts` package. The strongest argument _against_ a
codegen model — but for our context (Vite, regenerate-on-deploy is fine) codegen still wins.
([Surf](https://aptos.dev/build/sdks/ts-sdk/type-safe-contract))

## 6. NEAR — workspaces-rs / workspaces-js

**Test shape.** Tests construct a `Worker` (`Worker.init()`); either a `SandboxWorker` (local
in-memory sandbox) or `TestnetWorker`. Same code runs against either.
`root.createSubAccount('alice')`, `root.devDeploy('path.wasm')`, `account.call(...)`,
`contract.view(...)`. Sandboxes are **per-test**, isolated data dirs + ports. Concurrency is the
design point — they recommend AVA for native parallelism.
([near-workspaces-js](https://github.com/near/near-workspaces-js))

**Notable.** `patchState` rewrites arbitrary contract state / code / account / access-keys without
transaction validation. `fastForward` advances block height + timestamp + epoch height. Sui has
neither locally; if we ever need time-locked Move tests, this is the API shape to copy. Sandbox
startup ~1–2s per test, parallelized away.

## 7. Polkadot/Substrate — Zombienet (what our walrus plugin should study)

**Config.** TOML or JSON: `relaychain` (default_image, default_command, chain), `relaychain.nodes[]`
(per-node overrides + `validator: bool`), `parachains[]` (id, collator,
`genesis_wasm_path|generator`, `genesis_state_path|generator`). Env-var substitution via `{{ENV}}`.
**Pure data, no scripting.**
([Zombienet spec](https://paritytech.github.io/zombienet/network-definition-spec.html))

**Multi-provider abstraction.** Same config runs on `kubernetes`, `podman`, or `native` (host
processes), selected at CLI. _The_ central seam: a single `Provider` interface lets one TOML target
three runtimes. K8s mode also spins Prometheus + Tempo + Grafana sidecars.
([Zombienet docs](https://docs.polkadot.com/reference/tools/zombienet/))

**Test DSL.** `.zndsl` files with natural-language assertions like
`alice: parachain 100 block height is at least 10 within 200 seconds`. Built on `polkadot.js`;
custom JS scripts also valid. Launch dumps endpoints (WS, Prometheus) as formatted tables.

**No plugin model.** Providers are an enum, not extensible.

## 8. In-ecosystem (non-deepbook-sandbox) Sui prior art

**`@mysten/create-dapp`.** `npm create @mysten/dapp` scaffolds from templates (`react-client-dapp`,
`react-e2e-counter`). No local-chain orchestration, no Move publish step — it's a code generator,
not a dev harness. Closer to `create-react-app` than to Anchor.
([create-dapp](https://sdk.mystenlabs.com/dapp-kit/create-dapp))

**`@mysten/codegen`.** Move package → TS bindings via `sui move summary` + custom emitter. We use
it. Quirks: silent-fail on stdout, requires `sui` >= 1.51.1 on PATH. Generates per-module typed
function wrappers + BCS parsers. ([@mysten/codegen](https://www.npmjs.com/package/@mysten/codegen))

**`MystenLabs/walrus-docker-testbed`** + walrus's `scripts/local-testbed.sh`. Each
`docker compose up` starts a fresh Sui network, deploys Walrus contracts, generates dry-run
configs + wallets, exchanges SUI → WAL, brings up nodes. **Exactly what our walrus plugin
reimplements from scratch** — and the upstream testbed has the same problems we already fix in the
plugin (single-arch images, opinionated committee size, no port allocator).
([walrus-docker-testbed](https://github.com/MystenLabs/walrus-docker-testbed))

## What we should consider stealing

1. **Anchor's IDL → typed-client + uploaded-to-chain story.** `@mysten/codegen` gives us the
   typed-client half, but we don't store the package's ABI/IDL on-chain or publish a per-package npm
   artifact. For a "third-party app consumes our Move package" flow, on-chain IDL discovery would be
   a real upgrade. Open question for our `runCodegen` step.
2. **Beaker's interactive console.** A `devstack console` REPL with `manifest`, `accounts`,
   `client`, `packages.<name>.<fn>()` already bound — a half-day implementation that would massively
   shorten the "exploring my own deployed package" loop. Stronger than the `endpoints()` banner.
3. **Zombienet's provider abstraction.** Our walrus plugin assumes Docker Compose. A native-process
   provider (skip Docker entirely on ARM Linux) is the same interface. Worth doing if/when we get
   the second consumer of "spawn a multi-node service."
4. **Anchor's `[test.validator.clone]`.** A `clone` field in `devstack.config.ts` for "pull this
   object/package from mainnet into localnet at startup" is a much better fork-from-mainnet story
   than what we have (nothing). Especially relevant for testing against real DeepBook v3 pools
   instead of importing-and-republishing.
5. **NEAR's `patchState` + `fastForward`.** If our test suite ever needs time-locked Move logic or
   "skip ahead 10000 epochs" semantics, this is the API shape — and it requires either upstream Sui
   sandbox support or a devstack RPC shim. Park for now.
6. **Ignite's `apps` plugin marketplace.** Convention for naming (`@<scope>/devstack-plugin-<name>`)
   plus a `devstack doctor` probe for plugin-version drift would let us move from "in-tree plugins"
   to "any npm package can be a plugin" without changing core. Parked in §10.2 q7 of the design doc.

## What to avoid

1. **Beaker's Rhai-scripted plugin model.** Plugins-as-scripts loses typing, Zod manifest
   contributions, and `doctor()`/`endpoints()` symmetry. Our typed-closure plugin model is better.
2. **Anchor's monolith (pre-1.0).** No extensibility; adding a feature meant patching anchor itself.
   `[scripts]` shelling out to npm was the only escape valve. Our `DevstackPlugin` is the right
   call.
3. **Surf's inference-only Move bindings.** Tempting (no build step) but pushes type-load onto the
   consumer's TS server and blocks publishing a `.d.ts` artifact.
4. **solana-test-validator per-test restart.** 5–10s startup per test is the equivalent of
   faucet-per-test in our friction journal. Our `AccountPool` + shared globalSetup already avoids
   it.
5. **Zombienet's `.zndsl` test DSL.** A parallel test surface that doesn't compose with the host
   language. Typed `defineDevstackVitestConfig` + `inject('devstack')` is more honest.
6. **create-dapp-style "scaffold and walk away."** Templates without an ongoing relationship with
   the harness drift immediately. Apps-in-monorepo + shared devstack version is a real improvement.

## Sources

- [Anchor.toml configuration](https://www.anchor-lang.com/docs/references/anchor-toml)
- [Anchor IDL docs](https://solana.com/docs/programs/anchor/idl)
- [Anchor 1.0 announcement](https://x.com/solana_devs/status/2039837963840803283)
- [Anchor LiteSVM template](https://www.anchor-lang.com/docs/testing/litesvm)
- [solana-test-validator guide](https://solana.com/developers/guides/getstarted/solana-test-validator)
- [Bankrun tutorial](https://kevinheavey.github.io/solana-bankrun/tutorial/)
- [Bankrun + Jest](https://solana.com/developers/guides/advanced/testing-with-jest-and-bankrun)
- [Ignite CLI configuration](https://docs.ignite.com/configuration/config)
- [Ignite scaffold chain docs](https://docs.ignite.com/v0.25/kb/scaffold-chain)
- [Beaker repo](https://github.com/osmosis-labs/beaker)
- [Beaker config docs](https://github.com/osmosis-labs/beaker/blob/main/docs/config/README.md)
- [Aptos CLI](https://aptos.dev/build/cli/working-with-move-contracts)
- [Aptos Surf](https://aptos.dev/build/sdks/ts-sdk/type-safe-contract)
- [near-workspaces-js](https://github.com/near/near-workspaces-js)
- [Zombienet repo](https://github.com/paritytech/zombienet)
- [Zombienet network spec](https://paritytech.github.io/zombienet/network-definition-spec.html)
- [Zombienet provider docs](https://docs.polkadot.com/reference/tools/zombienet/)
- [@mysten/create-dapp](https://sdk.mystenlabs.com/dapp-kit/create-dapp)
- [@mysten/codegen](https://www.npmjs.com/package/@mysten/codegen)
- [walrus-docker-testbed](https://github.com/MystenLabs/walrus-docker-testbed)
