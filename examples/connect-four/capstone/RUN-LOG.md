# Capstone run log — "Deploy to a real network"

Fill this in **from a real run** by the owner. Live nets are slow/flaky and the
faucet rate-limits, so this is run by hand (not in CI). One entry per validated
run; keep the most recent at the top.

See [`README.md`](./README.md) for the scenarios and exact commands, and
[`run-capstone.sh`](./run-capstone.sh) for the Scenario B runner.

---

## Expected shape of a successful run

> Template — copy this block, replace the `<…>` placeholders with real values.

```
Date:            <YYYY-MM-DD>
Operator:        <name>
sui --version:   <e.g. sui 1.x.x-…>
Network:         devnet

── Scenario A — pure prod build (not through devstack) ───────────────────────
Published package id:   <0x… from `sui client publish move/connect_four`>
deployments/devnet.ts:  package id matches published id   [ PASS / FAIL ]
pnpm build (drop-local, no Docker):                       [ PASS / FAIL ]
No dev wallet in dist/ (grep -rl dev-wallet dist/assets):  none found  [ PASS / FAIL ]
Served app connects to devnet RPC + reads real id:        [ PASS / FAIL ]
External-wallet tx landed on devnet (digest):  <0x…>      [ PASS / FAIL ]

── Scenario B — both networks in dev, dev wallet drives devnet tx ────────────
Runner:  ./capstone/run-capstone.sh

network-switch.spec.ts:
  localnet→devnet switch took effect (bridge currentNetwork=devnet):  [ PASS / FAIL ]
  dev wallet stayed connected across switch (same address):           [ PASS / FAIL ]
  app repointed (Network: devnet indicator):                          [ PASS / FAIL ]

devnet-tx.spec.ts:
  alice funded on devnet (suix_getBalance > 0):                       [ PASS / FAIL ]
  create_lobby tx executed after switch:                              [ PASS / FAIL ]
  alice address:   <0x… (64 hex)>
  tx digest:       <base58 digest, e.g. 7xK…>
  sui_getTransactionBlock: sender=alice, status=success, Lobby created [ PASS / FAIL ]
  explorer:        https://suiscan.xyz/devnet/tx/<digest>

── Scenario C — per-network services (deepbook/walrus/seal) ──────────────────
  DEFERRED — run against a service-bearing live net (likely testnet); not part
  of the devnet A/B run. Record separately when validated.
```

---

## Runs

<!--
Paste completed run blocks here, newest first. Until the owner runs the live
harness this section is intentionally empty — typecheck/unit-green is NOT a
substitute for a real on-chain run.
-->

_No live run recorded yet. Run `./capstone/run-capstone.sh` (Scenario B) and the
Scenario A manual steps, then paste a completed template block above._
