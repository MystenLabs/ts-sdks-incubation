# Deferred work

PRs proposed during prior architecture-review rounds and deferred with
rationale. Each item is a thumb-sketch — revisit when a concrete reason
to act on one materializes. Not friction (the pain is captured already
elsewhere or doesn't exist yet); not verification (no hands-on check
owed). Pure "we decided not to do this now."

### B7 — deepbook `poolNeeds` auto-derive

Pool specs reference `@reg/<name>` tokens that get registered at run time
inside `onPublished` hooks. Auto-deriving `needs:` from the references
would require mapping `@reg/<name>` → registering action at expansion
time, but the registering action only exists post-publish — so the
derivation is fragile by construction. Manual `poolNeeds` continues to
work.

### C2 — npm publishing

`@mysten-incubation/devstack` is at `1.0.0` with public `publishConfig`,
so the package is technically publishable. Outstanding work before a
real `pnpm publish`:

- Confirm the workspace siblings devstack depends on at runtime
  (`@mysten-incubation/dev-wallet`, `@mysten-incubation/devstack-wallet-panels`)
  also publish in lockstep — pnpm rewrites `workspace:*` to a real
  version on publish, so any sibling that stays unpublished will 404 at
  consumer install time.
- Run `pnpm pack && tar -tzf` against the produced tarball + a fresh-
  cwd `npm install` to confirm the file tree, exports map, and bin
  shebang survive the publish round-trip.

### E1 — `loadFixture()` for parallel e2e

Every plausible mechanism trades against a different cost: per-test
snapshot restore is ~15 s on `docker commit`-based snapshots (too slow);
per-stack-per-test means N parallel containers; in-memory revert needs a
Sui-side checkpoint API we don't have. Revisit when a specific e2e suite
is measurably bottlenecked by `mode: 'serial'`.

### E2 — Supervisor-TUI manual action triggers

Hotkeys for re-running specific actions (a debug aid for plugin
authors). Lower-priority QoL.

### G5 — Move `packages/docs` → `apps/docs`

Per AGENTS.md, docs sites belong under `apps/`. Cosmetic alignment;
blocked because the Vercel deployment's "Root Directory" is set to
`packages/docs/` via the project UI — moving from this side breaks
deploys until a UI change. Revisit on a release decision.

### F1 sui — `genesis` opt

Bind-mount a pre-baked genesis blob into the localnet container. The
upstream container generates genesis on `--force-regenesis` so this is
strictly an advanced case. Capture a concrete use case in
`friction.md` first before committing to an API shape.

### F2 walrus — `appendLog` supervisor-TUI plumbing, `nodeCount` opt, per-node `verify()` actions

- `appendLog`: walrus's build streams stderr. The missing piece is
  routing that stream through the supervisor's TUI panel via
  `ctx.appendLog`; bigger than just the walrus side.
- `nodeCount`: `NODE_COUNT = 4` is hardcoded across 8 sites (subnet IPs,
  port range, container names, config-gen). Refactor lift; defer until
  there's a concrete reason to need a different count.
- Per-node `verify()` actions: real new actions (one per node, probing
  REST API liveness). Worth its own focused PR.
