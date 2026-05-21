# Phase F — manual scenarios runbook (2026-05-20)

> **Current-state warning (2026-05-21):** this is historical manual-scenario planning context.
> Current P0 blockers in `UNRESOLVED-BLOCKERS.md` must be closed before manual scenarios can serve
> as a cutover signoff.

Per-scenario runbook for the manual-test deliverables: parallel stacks, port reassignments, doctor /
bad-state handling, cleanups, cross-host PID scenarios. The user-mandate is "manually test parallel
stacks, port reassignments, doctor/bad state handling, cleanups etc"; this doc gives the
orchestrator one runbook entry per scenario with explicit setup, expected behavior, induced-failure
modes, and success criteria.

Each scenario uses one of two test apps as the harness:

- **A**: `examples/hello-world-rewrite/` (cheapest — sui + 2 accounts).
- **B**: `examples/wallet-rewrite/` (richer — sui + accounts + packages + coins + wallet + action).

Run from the example dir: `pnpm devstack up --stack <name>` (or the rewrite's CLI equivalent once
PR6 lands; for now invoke the supervise flow via the `test/e2e/boot-config-impl.ts:runBoot`
programmatic API).

Memory invariants honored throughout: local Docker is the substrate; real device + real containers;
no CI loops for verification.

---

## 1. Parallel stacks

### Setup

```bash
# Terminal 1:
cd examples/hello-world-rewrite
pnpm devstack up --stack pair-a
# Terminal 2 (NEW shell, while terminal 1 is alive):
cd examples/hello-world-rewrite
pnpm devstack up --stack pair-b
```

Per the substrate's per-stack-registries + per-stack docker labels + `PortBrokerService` design,
both stacks must reach ready without fighting each other.

### Validate

- Both stacks emit a READY transition for every plugin key.
- `docker ps --filter label=devstack.stack=pair-a` lists pair-a's containers ONLY; same for
  `pair-b`.
- Sui faucet endpoints + RPC endpoints differ across the two stacks (read each stack's
  `.devstack/manifest.json`).
- `pnpm devstack down --stack pair-a` does NOT terminate pair-b's containers.
- After both shut down, `docker ps -a --filter label=devstack=true` is empty.

### Failure modes

- Both stacks pick the SAME ephemeral port → PortBroker collision.
- Container name collision because the per-stack label prefix isn't applied.
- Roster.json entries leak across stacks.

### Success criteria

- Both stacks ready, no docker name/port collisions, independent shutdown, no leaked containers.

**Per-service sub-checklist** (per memory `feedback_parallel_stack_audit`): do the parallel-boot run
with each plugin individually — sui, faucet, wallet, walrus, seal, deepbook, postgres. Engine-level
claims do NOT substitute. The current parity-matrix CLOSE row "Parallel-stack support" explicitly
requires this.

---

## 2. Port reassignments

### Setup

```bash
# Bind port 5173 (the canonical vite dev port) before booting:
python3 -m http.server 5173 &
HOLDER=$!

cd examples/wallet-rewrite
pnpm devstack up --stack port-test
```

Reuses example B because the wallet+vite combination is the realistic "two-port-claimant" scenario.

### Validate

- The `PortBrokerService` allocator detects 5173 is bound and reassigns to the next free port.
- The published manifest (`.devstack/stacks/port-test/manifest.json`) advertises the reassigned
  port, NOT 5173.
- The wallet routable + vite cold-start URL both reflect the reassigned port consistently (no
  advertised-vs-actual drift).
- After teardown, release `HOLDER` (`kill $HOLDER`).

### Failure modes

- Boot hard-fails because 5173 EADDRINUSE.
- Boot succeeds but emits 5173 in manifest while serving on a different port.
- Two clients (one reading manifest, one inferring from envvar) get different ports.

### Success criteria

- Boot succeeds with manifest reflecting the actually-bound port. No drift between the cold-start
  URL helper, the manifest, and the live socket.

---

## 3. Doctor / bad-state handling

The rewrite's `doctor` verb exists but `probes: []` is currently empty (per parity-matrix top-5
cutover blocker #2). Each sub-scenario below both **induces a failure** and **defines what the
doctor probe should report** once probes are wired (PR6).

### 3a. Corrupted `roster.json`

**Induce:** boot stack A, kill the host process with `kill -9`, then manually write garbage:

```bash
echo 'not-json' > $(devstack paths --stack <name>)/roster.json
```

**Expected:** next `up` detects the corruption and either heals (regenerates from PID liveness
probes) or fail-fast with a clean typed error pointing at the corrupted file. Doctor should report
`RosterCorrupt` with the file path.

**Heal:** delete `roster.json`; next boot re-derives.

### 3b. Orphan `stack.lock`

**Induce:** boot stack A, kill -9 the host process so the lock isn't released.

**Expected:** next `up` reads PID+startTime from the lock file, sees the PID is dead (cross-process
liveness predicate at `substrate/runtime/cross-process/liveness.ts`), reclaims the lock and
proceeds. Doctor (`--clean-locks`) should report `StackLockOrphan` and offer to reclaim.

### 3c. Stale snapshot reservation

**Induce:** start a snapshot capture (`devstack snapshot save`), kill the host mid-capture via
`kill -9`.

**Expected:** the `.snapshot.reservation` file lingers. Next `snapshot save` should detect the stale
reservation via PID liveness and reclaim it (same predicate as stack.lock). Doctor should report
`SnapshotReservationStale`.

### 3d. Dangling container

**Induce:** boot stack A, kill -9 the host, manually remove its `roster.json`. The substrate now has
no roster knowledge of the still-running container.

**Expected:** next `up` runs the docker sweep (`runtime/docker/sweep.ts`) — labels narrow to
`devstack.stack=<name>`, finds the orphan, removes it. Doctor should report `DanglingContainer` with
the container id + label set.

### 3e. Network leak

**Induce:** boot stack A; kill -9 host before teardown; `docker network ls | grep devstack` shows
the per-stack bridge still present.

**Expected:** sweep removes the bridge network as part of orphan-cleanup. Doctor should report
`OrphanNetwork`.

### Success criteria (whole §3)

- Every induced bad state is **detectable** by doctor (clean error message naming the offending
  artifact) and **healable** (either automatic on next `up` or via an explicit `--clean-*` flag). No
  "next boot silently succeeds while the orphan still leaks" outcomes.

---

## 4. Cleanups

### 4a. Kill -9 supervisor; next run heals

```bash
cd examples/hello-world-rewrite
pnpm devstack up --stack cleanup-a &
SUP=$!
# wait for ready (poll roster.json or watch logs)
kill -9 $SUP
# Verify: stack.lock + roster.json contain stale entries, containers still alive.
pnpm devstack up --stack cleanup-a
# Verify: previous containers either reclaimed (same labels, still healthy)
# or torn down + recreated. Stack reaches ready cleanly.
```

**Success:** second `up` reaches ready without manual cleanup steps. No `docker ps` orphans after
final shutdown.

### 4b. Snapshot save → kill → resume from snapshot

```bash
cd examples/walrus-mini-rewrite
pnpm devstack up --stack snap-test &
# wait for ready
pnpm devstack snapshot save --stack snap-test
kill -9 $!
# Move ahead one calendar day or just reboot the machine if local.
pnpm devstack up --stack snap-test --from-snapshot latest
# Verify: state from before the kill is present (seeded blob still in walrus aggregator).
```

**Success:** the on-disk snapshot survives an unclean shutdown and a subsequent boot resumes from it
cleanly. Per parity-matrix, snapshot capture+restore are wired; the unclean-shutdown variant is the
new assertion.

### 4c. Scope-finalizer container cleanup (programmatic)

For the e2e tests in `test/e2e/`, every `runBoot()` ends with the `Effect.scoped` boundary firing.
After the test exits, the test must assert:

```bash
docker ps -a --filter label=devstack.stack=<test-stack-name> -q
# expected empty
```

**Success:** zero output. If non-empty, finalizer ordering is broken. This is the assertion
`phase-f-infra.md` suggests folding into the shared `bootExample()` helper.

### 4d. Tmpfile + state-dir cleanup

```bash
ls $(devstack paths --stack throwaway)/tmp/ # should be empty after teardown
```

(The runtime root that `boot-config-impl.ts:114` mkdtempSync's per-call is OS-reaped, but the
supervised runtime carries its own `.devstack/<app>/<stack>/tmp/` for atomic-write tempfiles — every
`atomic-write.ts` callsite must rename-or-cleanup; a leaked `.tmp` file is a violation.)

---

## 5. Cross-host PID liveness

The substrate's `liveness.ts` is documented to be conservative when a roster entry has a `host`
field that doesn't match the local machine: foreign-host entries are treated as alive
(default-alive) until proven dead by other means (the roster's heartbeat field, or an explicit
`doctor --reclaim-foreign-host` action).

### 5a. Foreign-host PID appears in roster

**Induce:** hand-edit `.devstack/stacks/<name>/roster.json` so an entry's `host` field contains an
unrecognized hostname (e.g. `host: "some-other-laptop.local"`). Use a PID that doesn't exist on the
local machine (e.g. PID 99999).

**Expected:** next `up` on this host does NOT reclaim the foreign-host entry as dead-by-PID-probe
(the PID probe is host-local). Instead, the substrate treats it as alive-by-default and refuses to
take the lock until the foreign host releases it (or the user explicitly forces via
`--reclaim-foreign-host` once that verb lands).

### 5b. Foreign-host PID with stale heartbeat

**Induce:** same as 5a, but additionally set the entry's `lastHeartbeat` field to a timestamp >10
minutes old.

**Expected:** substrate detects stale heartbeat, schedules a reclaim (the heartbeat-based predicate
is the only safe cross-host signal). Doctor reports `ForeignHostStale`.

### Success criteria (§5)

- Foreign-host entries are **never** reclaimed as dead solely on local-PID-probe grounds. Heartbeat
  staleness is the only safe cross-host predicate. Tests verify by injection (write a synthetic
  foreign-host entry; assert reclaim behavior matches predicate).

---

## 6. Cross-cutting checklist — every scenario must satisfy

These are post-conditions every manual scenario above must verify before moving to the next:

- [ ] `docker ps -a --filter label=devstack=true` has only the containers that the running stack(s)
      own.
- [ ] `.devstack/<app>/<stack>/` has no `*.tmp.*` files older than 60s.
- [ ] No port in the manifest is bound by anything other than the reported owner (cross-check with
      `lsof -i :<port>`).
- [ ] Every plugin key reached READY (or the scenario explicitly induced a failure and the failure
      is named in the projection's `errors[]`).
- [ ] Re-boot of the same stack from a CLEAN state (manual `rm -rf .devstack/<app>/<stack>` after
      teardown) reaches ready in the same time budget as the original.

---

## 7. Dispatch shapes

Manual scenarios convert to dispatch shapes in two waves:

**Wave 1 (no blockers):** parallel-stacks (§1), port reassignment (§2), kill-9 cleanup (§4a), scope
finalizer cleanup (§4c).

**Wave 2 (after PR6 CLI verb wiring + doctor probes):** doctor / bad-state (§3a-e), snapshot
kill+resume (§4b), foreign-host PID (§5).

Each scenario's "Validate" + "Success criteria" sections are precise enough to be a single agent
prompt: _"Run the runbook in §<n>; report which post-conditions pass and which fail; for each
failure, file the root cause."_

---

## Opportunities noticed

1. **`devstack paths --stack <name>` doesn't exist as a verb** — every scenario above needs to know
   the runtime root path. Either add a `paths` subverb to the CLI, or document that the path is
   `~/.devstack/<app>/<stack>/` (the locked convention) so users don't `find` for it.
2. **Doctor probe coverage maps 1:1 to the §3 induced-bad-states** — when PR6 wires doctor probes,
   the natural shape is one probe per §3 sub-scenario. The runbook above doubles as a
   probe-completeness checklist.
3. **The §4c finalizer-container-cleanup post-condition** belongs in the shared e2e harness, not in
   each test (see `phase-f-infra.md`). Without it, finalizer regressions land silently.
4. **§5 (cross-host PID) requires synthetic roster injection** — the substrate has no "fake foreign
   host" mode today. A test-only `DEVSTACK_INJECT_FOREIGN_HOST=<hostname>` envvar in `liveness.ts`
   would let CI exercise the conservative-alive predicate without two physical machines. Track as a
   separate substrate addition before §5 can be e2e-verified.
5. **The §1 parallel-stack per-service sub-checklist (per memory `parallel_stack_audit`) is
   currently informal.** Codify as a per-plugin parallel-boot test in
   `test/e2e/parallel-<plugin>.test.ts` once the plugins land.
6. **Manual runbook drift is a real risk** — when CLI verbs (`devstack snapshot save`,
   `devstack paths`, `devstack doctor`) get renamed, this doc rots. Mitigation: every CLI verb
   mentioned here should have a sibling automated test in `test/surfaces/cli/`, and this doc should
   be regenerated from the CLI's `--schema --json` introspection at cutover.
