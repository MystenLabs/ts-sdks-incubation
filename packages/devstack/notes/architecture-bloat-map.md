# Devstack architecture-bloat map — why simplification kept failing, and the real path

Ground truth (owner): a working devstack with ~90% of these features existed at **~10k LOC**.
Current tree: **~83k**. The ~70k delta is **architecture, not feature code.**

## Why 5–6 simplification rounds all netted ~0
Every round was a **refactor** (move/merge/delete *within* the architecture). You cannot
refactor an over-architecture down to its feature-floor, because the bloat is **six
interlocking systems whose main customer is each other** — pull one and the others break,
so incremental elimination is impossible. The only path to ~10k is a **rewrite/port**, not
more refactor passes.

## The 70k = six interlocking architectural systems (scan-measured)
| System | Current LOC | Guarding owner-premise | If premise = simplify |
|---|---|---|---|
| Generic name-blind substrate kernel (ChainId, ContainerRuntime contract, cache generality, brokers, scoped-registry, reconciler, lifecycle FSM) | ~17.9k | **Second chain ever?** | Sui-only → ~2k imperative boot over a Docker driver |
| Plugin contribution/dispatch/ctx framework + per-plugin ceremony (codegen/errors/snapshot/routable/spans repeated per plugin) | ~2.7k + ~3.6k | **Third-party plugin authors?** | Sealed → plugins are direct functions |
| Live multi-process arbitration (supervisor, command-channel, roster, claims, liveness, 3 lock files) | ~5.0k | **Concurrent multi-shell / multi-stack?** | No → one lockfile; "apply" = re-run idempotent boot |
| Event-sourced read-model ring (projection + projection-snapshot, control-plane, observability-as-subsystem, manifest fan) | ~3.4k | **Live read-model?** | On-disk manifest is the read-model |
| Virtual-hosting router (Traefik, file-provider fan, hostname/profile) | ~3.1k | **Vanity/collision-free hostnames?** | Loopback URLs in the manifest |
| Multi-surface (Ink TUI + GraphQL dashboard + projection domain, divergent health bucketing) | ~4.0k | **Two surfaces?** | One view-model: `up` tails logs, dashboard is a static SPA over one JSON endpoint |
| (+ mode/strategy bus ~3.4k; feature-orchestrator dedup snapshot/codegen/tar) | | **Fork-mode shape** (keep feature, drop the 691-line mode module → ~150 branch) | |
| Plugin bodies + heavy built-ins | ~33.7k (≈21k eliminable, mostly ceremony + mode-shape) | | direct functions |

The cuts **stack** — each system's main consumer is another system on this list — so they
resolve together, not one at a time.

## Honest target: **10–12k** (matches the owner's existing 10k version)
Irreducible domain floor: Move publish + ABI→codegen ~3k, walrus/seal/deepbook bring-up
~1.5k, Sui boot (validator/faucet/funding/fork-branch) ~2.2k, Docker driver ~0.8k,
snapshot (commit + volume tar + cache copy) ~1.2k. Everything above that is collapsible
architecture.

## The path (NOT another refactor round)
1. **Resolve the 6 owner-premises** (second chain? plugin authors? multi-shell? live
   read-model? vanity hosting? two surfaces?). If they're all "simplify" — which the 10k
   version's existence implies — the rewrite is well-scoped.
2. **Port the existing 10k version forward** (+ the missing 10% + the wanted dashboard),
   using the current 83k as a *reference for hard-won fixes* (walrus per-node images +
   write-ready resume, identity-guard, warm-restart cache reuse, deploy-cache content-hash)
   — NOT as the base to refactor.
3. The current branch's WIP (lifecycle/snapshot unification + matrix-green) is worth
   finishing to stabilize/ship what's there, but it is NOT the path to 10k.

## Snapshot/codegen note (consistent with the 10k model)
Snapshot = `docker commit` + volume tar + **deploy-cache copy**. Codegen is **derived from
the deploy cache** (which is captured/restored), NOT captured as files — its output lives
in the app source tree, so it is **regenerated** from the restored cache on boot/resume,
never restored-as-files (which would clobber committed source). The matrix's codegen ENOENT
was the resume not *triggering* that (cheap, deterministic) regen — a completeness bug, not
a design choice.
