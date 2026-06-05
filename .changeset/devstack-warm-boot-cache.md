---
'@mysten-incubation/devstack': minor
---

Add `devstack up --warm` — a fingerprinted boot cache.

The first `--warm` boot is a normal cold boot that captures a baseline snapshot; subsequent `--warm` boots restore that baseline (fast path) instead of cold-booting, as long as the inputs are unchanged. The baseline is keyed on a fingerprint of the config source, the plugin/member graph, watched Move source contents, the devstack version, and image-override env vars; any change re-captures. Use `--no-warm` to force a cold boot, or set `warm: true` in devstack options. A change to per-plugin options is detected via the config-source hash; config logic split across imported modules or driven by environment is a known v1 limitation (use `--no-warm` / `wipe` after such changes).
