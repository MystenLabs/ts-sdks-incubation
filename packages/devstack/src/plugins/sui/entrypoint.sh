#!/bin/sh
# Devstack-managed sui-localnet entrypoint.
#
# Persistence: `sui start --force-regenesis` runs an ephemeral network
# (in-memory genesis). To preserve chain state across `docker stop` +
# `docker start`, we bootstrap once with `sui genesis -f --with-faucet`
# (writes a persistent config dir to /root/.sui/sui_config) and then run
# `sui start` (no --force-regenesis), which resumes from the on-disk
# state. As of `-r7` chain state lives in the container's writable layer
# (no `:/root/.sui` volume) — `docker stop` + `docker start` preserves
# it; `docker rm` destroys it. Snapshots capture state via `docker commit`.
#
# The walrus image bakes its own sui binary at build time; this entrypoint
# no longer publishes a copy of `sui` to a shared `/sui-bin` volume.
set -eu

mkdir -p /root/.sui

# Bootstrap genesis once per volume. `sui genesis` exits after writing
# the config; subsequent starts read it back.
if [ ! -d /root/.sui/sui_config ]; then
	sui genesis -f --with-faucet
fi

# Slow checkpoint pruning. The localnet's stock fullnode.yaml ships with
# `num-epochs-to-retain: 0`, which prunes checkpoints aggressively (we
# observed ~10 minutes of retention on a fresh chain). Walrus storage
# nodes follow the chain from when they were registered onward via the
# v2 LedgerService `get_full_checkpoint` gRPC; once their last-processed
# checkpoint slips below sui's `lowest-available-checkpoint`, walrus is
# permanently stuck (logs spam `Checkpoint <N> not found` and every blob
# write returns 400).
#
# Default retention: 2 prior epochs. With sui-localnet's default 24h
# epoch this holds 48–72h of history — enough for a multi-day dev session
# with restart cycles, while still bounding disk growth. Override with the
# `DEVSTACK_SUI_EPOCHS_TO_RETAIN` env var (set via the sui plugin's
# `epochsToRetain` option) — `MAX` disables pruning, anything else is
# parsed as a u64.
# Idempotent: rewriting the same line is a no-op; covers existing volumes
# that pre-date this fix.
RETAIN_RAW="${DEVSTACK_SUI_EPOCHS_TO_RETAIN:-2}"
if [ "$RETAIN_RAW" = "MAX" ]; then
	RETAIN=18446744073709551615
else
	RETAIN="$RETAIN_RAW"
fi
FULLNODE_YAML=/root/.sui/sui_config/fullnode.yaml
if [ -f "$FULLNODE_YAML" ]; then
	# Always rewrite both fields so a changed `epochsToRetain` option takes
	# effect on the next start without requiring a `devstack stack drop`.
	# `num-epochs-to-retain-for-checkpoints` may already be present from a
	# prior boot; the second sed handles that case.
	sed -i "s/^  num-epochs-to-retain: .*\$/  num-epochs-to-retain: ${RETAIN}/" "$FULLNODE_YAML"
	if grep -q '^  num-epochs-to-retain-for-checkpoints:' "$FULLNODE_YAML"; then
		sed -i "s/^  num-epochs-to-retain-for-checkpoints: .*\$/  num-epochs-to-retain-for-checkpoints: ${RETAIN}/" "$FULLNODE_YAML"
	else
		sed -i "/^  num-epochs-to-retain: ${RETAIN}\$/a\\  num-epochs-to-retain-for-checkpoints: ${RETAIN}" "$FULLNODE_YAML"
	fi
fi

exec sui "$@"
