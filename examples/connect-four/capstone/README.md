# Deploy to a real network — capstone validation harness

A **documented, repeatable** harness that proves the devstack multi-network
deployment path works against a *real* Sui network, not just a typecheck/unit
pass. Typecheck-green is necessary but not sufficient — only a real deploy proves
the prod path (`deploy = drop-local`, committed `deployments/<net>.ts`,
per-network client repoint, dev-wallet-persists-across-switch) actually works
end to end.

> **This is NOT a CI gate.** Live networks are slow and flaky, the faucet rate-limits,
> and tx finality is non-deterministic. The harness is run **by hand** by the owner
> against devnet (free, faucet-backed). Record the result in [`RUN-LOG.md`](./RUN-LOG.md).

The harness exercises the **template counter / connect-four** package on Sui
**devnet** (devnet has a public faucet → free gas). It verifies the running app
with [agent-browser]/Playwright, not just exit codes.

---

## What's already committed (the proof artifacts)

The two browser specs that *are* the capstone proof, plus the committed devnet
deployment, already live in the repo:

| Artifact | Path | Proves |
| --- | --- | --- |
| Network-switch spec | [`../tests/browser/network-switch.spec.ts`](../tests/browser/network-switch.spec.ts) | localnet→devnet UI switch; dev wallet stays connected; client repoints (Scenario B, no tx) |
| Devnet-tx spec | [`../tests/browser/devnet-tx.spec.ts`](../tests/browser/devnet-tx.spec.ts) | funds alice via the devnet faucet, signs a real `create_lobby` after the switch, asserts the tx landed via `sui_getTransactionBlock` (Scenario B, with tx) |
| Committed devnet deployment | [`../deployments/devnet.ts`](../deployments/devnet.ts) | typed per-network unit, `satisfies AppNetworkDeployment` (a wrong/typo'd id fails `tsc`) |

This `capstone/` directory adds the **deliverable framing**: the runner script,
this README, and the run log.

---

## Prerequisites (all scenarios)

- **`sui` CLI on `PATH`** — used to publish the Move package to a live network.
  `suiup install sui@mainnet` or see <https://docs.sui.io/guides/developer/getting-started/sui-install>.
  Verify: `sui --version`.
- **A devnet faucet** — public HTTP faucet at `https://faucet.devnet.sui.io/v2/gas`
  (the `devnet-tx` spec hits this directly; manual funding can also use
  `sui client faucet`). devnet gas is free and ephemeral.
- **Repo built** — devstack CLI dist + example deps:
  `pnpm install && pnpm --filter @mysten-incubation/devstack build`.
- **Node ≥ 24**, Docker running (for the localnet `e2e` stack that Scenario B boots).
- **A funded publisher keypair on devnet** for the manual publish step
  (`sui client active-address`, then `sui client faucet`).

---

## Scenario A — pure prod build, NOT through devstack

**Goal:** prove the deploy-time path with no local stack at all: a static `vite
build` that ships the committed `deployments/devnet.ts`, connects to devnet RPC,
reads the *real* package id, lands a tx signed by an external keypair, **and
carries NO dev wallet** in the bundle.

> Status: documented here; the *automated* proof in this branch is Scenario B
> (which subsumes the switch + devnet-tx assertions). Scenario A's distinct
> assertions are the **drop-local build** and the **no-dev-wallet-in-bundle**
> grep — run the manual steps below to validate them.

### Steps

1. **(MANUAL) Publish the Move package to devnet.** From the example dir:
   ```bash
   cd examples/connect-four
   sui client switch --env devnet            # ensure active env is devnet
   sui client faucet                          # fund the active address on devnet
   sui client publish move/connect_four --gas-budget 100000000
   ```
   Copy the published **package id** from the output (`Published Objects → PackageID`).

2. **Write the committed, typed deployment.** Either:
   - **Option A1 (hand-author):** edit [`../deployments/devnet.ts`](../deployments/devnet.ts),
     set `CONNECT_FOUR_PACKAGE_ID` to the published id. `satisfies AppNetworkDeployment`
     makes `tsc` reject a missing/typo'd id. *(This is how the committed file was produced.)*
   - **Option A2 (boot + dump):** point a one-shot devstack boot at devnet and let it
     emit the typed file:
     ```bash
     pnpm exec devstack dump-deployment --network devnet
     #   ↳ writes deployments/devnet.ts (export const deployment = {…} satisfies AppNetworkDeployment)
     ```
     `dump-deployment --network <net>` reads the resolved envelope's `networks.<net>`
     entry and renders the typed single-network file. (No `--network` → raw envelope
     JSON to stdout.)

3. **Build the static bundle with NO local stack:**
   ```bash
   pnpm build        # tsc -b && vite build — stack-free, no Docker, works on a clean clone
   ```
   The Vite plugin auto-discovers `deployments/*.ts`; `command === 'build'` drops
   local-mode and ships the committed networks only. A build with no ids throws
   `DevstackConfigMissingError` at runtime — loud, never a silent zero.

4. **Assert NO dev wallet shipped:**
   ```bash
   ! grep -rl "dev-wallet\|__devstackDevWallet__" dist/assets/*.js
   ```
   A pure prod build (not run through devstack) ships no dev-wallet plugin.

5. **Serve + verify with a browser:**
   ```bash
   pnpm preview      # serves dist/ statically
   ```
   With agent-browser / Playwright against the preview URL, confirm: the app
   connects to devnet RPC, reads the real package id, and a tx (signed by an
   external wallet / the publisher keypair) lands on devnet.

### Success looks like

- `pnpm build` exits 0 on a clean clone, no Docker.
- `dist/` contains the real devnet package id and **no** dev-wallet code.
- The served app connects to `https://fullnode.devnet.sui.io:443` and an
  externally-signed tx lands (verifiable on a devnet explorer).

---

## Scenario B — both networks in dev, dev wallet drives the devnet tx ✅ AUTOMATED

**Goal:** prove co-existence + switching: `devstack up` boots a live **localnet**
`e2e` stack while the committed `deployments/devnet.ts` supplies **devnet**, all
through devstack with the dev-wallet plugin on. The app lists `[localnet, devnet]`;
localnet works with funded local accounts; a `switchNetwork('devnet')` keeps the
dev wallet mounted, repoints the client, and — after manually funding alice on
devnet — the dev wallet signs a real tx that lands on devnet.

**This scenario is fully automated by the two committed specs and the runner
script** ([`run-capstone.sh`](./run-capstone.sh)).

### Steps

1. **(MANUAL, one-time) Ensure the committed devnet deployment is real.**
   [`../deployments/devnet.ts`](../deployments/devnet.ts) must carry a package id
   actually published to devnet (see Scenario A step 1–2). The `devnet-tx` spec
   does a real `create_lobby` against it.

2. **(AUTOMATED) Boot localnet + run the specs.** The `test:browser` script's
   `globalSetup` boots the `e2e` localnet stack, then tears it down:
   ```bash
   ./capstone/run-capstone.sh
   # which runs, with the right env:
   #   DEVSTACK_APP=connect-four DEVSTACK_STACK=e2e DEVSTACK_AUTO_APPROVE=1 \
   #     pnpm exec playwright test tests/browser/network-switch.spec.ts tests/browser/devnet-tx.spec.ts
   ```
   - `DEVSTACK_STACK=e2e` → isolated stack, parallel-safe with a developer's `pnpm dev`.
   - `DEVSTACK_AUTO_APPROVE=1` → the dev wallet auto-approves signing (no modal in headless).

3. **(AUTOMATED, inside the spec) Fund alice on devnet.** `devnet-tx.spec.ts` hits
   the public devnet faucet for alice's (network-agnostic) address and polls
   `suix_getBalance` until gas lands, before signing.

### What the specs assert (success criteria)

`network-switch.spec.ts`:
- after `switchNetwork('devnet')`, the dApp Kit current network = `devnet`;
- the dev wallet stays connected (same `.account-line code` address, not a ConnectButton);
- the network indicator repoints to `Network: devnet`.

`devnet-tx.spec.ts`:
- alice is funded on devnet (`suix_getBalance > 0`);
- after the switch, `Create Lobby` executes a real tx;
- `sui_getTransactionBlock` confirms the digest exists **on devnet**, `sender == alice`,
  `effects.status == success`, and a Lobby object was created.

Record the printed `[devnet-tx] alice=… digest=…` line in [`RUN-LOG.md`](./RUN-LOG.md).

---

## Scenario C — per-network services (0e) ⏸ DEFERRED / OPTIONAL

**Goal:** same as B, but with an example consuming **deepbook / walrus / seal**, to
prove service buckets resolve the right *per-network* ids on a `switchNetwork`
(`<svc>.forNetwork(net)` flips in lockstep with rpc/packages).

> **Caveat (why it's deferred):** walrus / seal / deepbook may **not** be deployed
> on devnet. Scenario C must run against whichever live net hosts them (likely
> **testnet**), with a hand-authored `deployments/testnet.ts` whose `values`
> namespaces are completeness-checked by `AppNetworkDeployment`. Core A/B stay on
> devnet; C is run separately when the owner validates 0e service routing against
> a service-bearing live net.

When run, C reuses the Scenario B harness shape against a service-consuming example
(`examples/deepbook-trader` / `private-content` / `token-studio`), asserting that a
runtime network switch flips the resolved service ids, not just rpc + package id.

---

## See also

- [`packages/devstack/notes/0d-implementation.md`](../../../packages/devstack/notes/0d-implementation.md)
  — the "Capstone: live-network validation" section (Scenarios A/B/C) this harness implements.
- [`../README.md`](../README.md) — the connect-four example's own "Deploy to a real network" section.

[agent-browser]: ../../../.agents/skills
