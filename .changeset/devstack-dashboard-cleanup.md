---
'@mysten-incubation/devstack': minor
---

Dashboard: explorer routing, plugin real-data, controls UX, and real faucet funding.

- **Explorer** — addresses, objects, and packages share one address space, so search now
  resolves an id first (package → object → address probe) and routes to the concrete kind
  instead of a generic entity route; objects can act as addresses (owned-objects/balances +
  package detection), and links from the transactions table route to concrete kinds. URL
  encoding no longer over-encodes path-safe characters.
- **Walrus / Seal panels** — Walrus shows real epoch, shard assignments, and recent blobs via
  Sui GraphQL (`register_blob`/`certify_blob` transaction filter, no indexer); Seal drops the
  policy pane and probes the correct `/health` endpoint.
- **Controls** — all restarts are behind a confirmation, restart is removed from the header,
  advance-clock is hidden unless on a fork, shutdown is no longer styled destructive, and the
  checkpoint figure is relabeled "Oldest checkpoint".
- **Account/address history** — Sent/Received transaction history via the typed
  `SuiGraphQLClient` from `@mysten/sui` (replacing hand-rolled fetch).
- **Snapshot/restore progress** — honest in-flight indicator (the engine emits no progress
  projection field) rather than fake instant success.
- **Faucet funding** — a `fund` control-plane mutation funds SUI/WAL/DEEP by reusing devstack's
  registered in-process funding strategies (the same ones the boot-time account-funding pass
  invokes), with a real processed/failed result; SUI is fixed-amount, WAL/DEEP take an editable
  amount and fund a resolved account.
