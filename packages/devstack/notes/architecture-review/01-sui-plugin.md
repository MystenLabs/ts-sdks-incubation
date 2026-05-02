# Sui plugin

**Verdict**: B+ — Solid, lived-in plugin that genuinely solves the cold-start-to-localnet problem; rough edges around the `-rN` tag versioning, an unused `keys.ts` lie, and brittle sed-driven yaml patching.

## Architecture

The plugin is well-decomposed across the three action types. `build` is gated by a cheap `imageExists` check; `localnet` is a `Service` whose `getStatus` does both the running-and-on-network probe and the RPC + checkpoint-retention checks; `accounts` is a `Register` that funds via the faucet and writes records into the registry. The split mirrors the architectural intent (build → service → register) and lets the reconciler skip warm-path work cleanly. The warm-path re-registration of services in `getStatus` (line 191) is a nice touch — fixes a class of bug where the registry empties when no run fires.

The container lifecycle is the strongest part. `index.ts:194-279` enumerates all four states explicitly: stopped+matching → `docker start` (resume from disk), stopped+stale → remove+rerun, running+matching → leave alone (`stillUsable`), absent → fresh run. The `imageMatches` check using the resolved image ref (not just a name match) is the right primitive for catching `-rN` upgrades. The shutdown hook (line 228) correctly stops the container on supervisor exit while preserving the named volume for next-up. The persistent-genesis pivot in entrypoint.sh is the kind of thing that earns the abstraction: `sui genesis -f` once, `sui start` thereafter, with the volume carrying the `sui_config` dir forward.

The fullnode.yaml patching is architecturally questionable. `entrypoint.sh:54-65` does sed-driven YAML rewrites on every boot to keep `epochsToRetain` in sync. It works for the current upstream layout (two-space indent, exact field names) but silently breaks if upstream renames a field or changes indentation. A more defensive approach would parse + emit YAML, or better, generate the file from a template rather than patch.

## Problem fit

The plugin nails the stated problem: a deterministic, reproducible, fast localnet on Apple Silicon. Native arm64 binaries from the Sui release tarballs (Dockerfile:22-34) sidestep Rosetta entirely — which is the right call per the principles doc. The persistent-genesis path makes inner-loop restarts cheap (no genesis time on `up` cycles), addressing the "fast restart over fast first start" principle. Boot health-checks gate downstream work without flaky polling.

The `epochsToRetain` work (commit `be3a3a2`, image `-r6`) is an example of the friction-journal-driven design paying off: walrus storage nodes silently break when checkpoints prune out from under them, and the plugin both fixes the default *and* surfaces the failure mode at the status layer via `probeCheckpointRetention`. The probe-tied-to-getStatus pattern means a custom image regression fails loud.

## Integration

The capability handshake with walrus is elegant on paper: walrus declares `provides: ['walrus.app-network']` with the subnet pin, sui declares `needs: ['walrus.app-network:before']` (soft), so the dependency graph orders the network creation before sui's network ensure. Sui's plugin doesn't directly import walrus, but walrus imports `appNetworkName` and `suiBinVolumeName` (it actually re-defines `suiBinVolumeName` at line 74 — duplicated, a bug-in-waiting). The shared `sui-bin` volume + `sui-localnet` DNS alias are the actual cross-plugin contracts, and they're implicit, not typed. A walrus-side typo in the alias name would compile-pass and runtime-fail.

The `containerOnNetwork` probe (line 387) is a thoughtful guard against pre-retrofit containers on the wrong network. But `suiBinVolumeName` being redefined in `walrus/index.ts:74` rather than imported from `sui/index.ts` is the leak that will eventually rot — it's lowercase + un-exported in sui/index.ts:112, so walrus has no choice but to duplicate.

## Customizability + gaps

- **`suiBinVolumeName` not exported** — walrus duplicates the constructor; a rename in sui breaks walrus silently.
- **No way to disable account funding / faucet wait** — apps that don't declare accounts still pay the localnet startup cost of `waitForFaucet`. Acceptable, but `accounts` is non-skippable in declared-empty form.
- **`SUI_DEFAULT_VERSION` is a single global** — pinning per-stack/per-app requires passing `version` everywhere; no cookbook for "use mainnet binary against localnet genesis."
- **Hardcoded `-r6` tag suffix** is a manual revision counter; the comment says "bumped manually." A content-hash of the Dockerfile + entrypoint would invalidate automatically.
- **No `clientYaml` materialization** — apps that want `sui client` from the host can't easily get a configured client.yaml.
- **No platform override** — `runContainer` accepts `platform` but the sui plugin doesn't expose it. Multi-arch hosts are fine, but cross-arch debugging is blocked.
- **Faucet timeout fixed at 5s** in `keys.ts:24` — no override despite a `settleTimeoutMs` field. Multi-account `up` could blow this on a slow host.
- **`'publisher'` role is hardcoded** in `index.ts:313,336` — leaks app-level convention into the plugin.
- **Healthcheck duplicates `probeRpc`** — the docker-level healthcheck and the JS-level probe both do the same JSON-RPC call. Drift risk.
- **`keys.ts` lies about itself** — header says "Per-account key management lives in `helpers/keystore.ts`," but this file is just the faucet. Stale comment.

## Testing

No tests cover the sui plugin specifically. The `docker.ts` wrappers are untested; `health.ts` probes are untested; `keys.ts` `ensureFunded` is untested; `entrypoint.sh`'s sed transforms are untested (the failure mode of "upstream changed yaml indentation" is invisible until a real localnet runs). What *is* tested: `topo.test.ts` exercises the `walrus.app-network:before` capability ordering as a unit; `plugin.test.ts:109` validates the capability-query syntax. So the *contract* between plugins is tested but none of the *implementation* the sui plugin owns is. A unit test for the entrypoint's sed transform (run as a shellcheck + golden-file comparison against a real `fullnode.yaml`) would be high-value, low-cost.

## Top recommendations

1. **Export `suiBinVolumeName`, `SUI_LOCALNET_ALIAS`** — make the cross-plugin contract explicit; drop the duplicated definition in walrus/index.ts:74. While at it, export a typed `SuiPluginContract` interface so walrus depends on a name, not a string.
2. **Replace sed-driven yaml patching with a template** — generate `fullnode.yaml` from a known-shape template + the runtime params, instead of patching upstream's. Eliminates a silent-breakage class on upstream upgrade.
3. **Auto-derive the `-rN` suffix from a content hash of `Dockerfile + entrypoint.sh`** — drop the manual revision counter. The current strategy has already been bumped 6 times; it'll bit-rot.
4. **Add a single integration test** that spins up the localnet, asserts RPC + faucet + checkpoint-retention, and tears down. Without it, regressions in the sed patch / image build will land in user repos before they land in CI.
5. **Move the hardcoded `'publisher'` role out of the plugin** — let apps declare account roles in their config, not the plugin code.
