#!/bin/sh
# devstack-next sui-localnet entrypoint.
#
# `sui start --force-regenesis` is ephemeral (in-memory genesis). To
# preserve chain state across `docker stop` + `docker start`, we
# bootstrap once with `sui genesis -f --with-faucet` (writes a
# persistent config dir under /root/.sui/sui_config) and then run
# `sui start` (no --force-regenesis), which resumes from the on-disk
# state. Chain state lives in the container's writable layer — `docker
# stop`/`start` preserves it; `docker rm` destroys it.
#
# Slow checkpoint pruning. The localnet's stock fullnode.yaml ships
# with `num-epochs-to-retain: 0`, which prunes checkpoints aggressively
# (~10 minutes of retention on a fresh chain). Downstream consumers
# that follow the chain sequentially (e.g. walrus storage nodes via
# the v2 LedgerService `get_full_checkpoint` gRPC) get permanently
# stuck once their last-processed checkpoint slips below sui's
# lowest-available-checkpoint. Default retention here is 2 prior
# epochs (~48–72h at the localnet's default 24h epoch); override via
# the `DEVSTACK_SUI_EPOCHS_TO_RETAIN` env var (`MAX` disables pruning).
set -eu

mkdir -p /root/.sui

if [ ! -d /root/.sui/sui_config ]; then
	sui genesis -f --with-faucet
fi

RETAIN_RAW="${DEVSTACK_SUI_EPOCHS_TO_RETAIN:-2}"
if [ "$RETAIN_RAW" = "MAX" ]; then
	RETAIN=18446744073709551615
else
	RETAIN="$RETAIN_RAW"
fi
FULLNODE_YAML=/root/.sui/sui_config/fullnode.yaml
if [ -f "$FULLNODE_YAML" ]; then
	# Idempotent rewrite — covers volumes that pre-date this fix.
	sed -i "s/^  num-epochs-to-retain: .*\$/  num-epochs-to-retain: ${RETAIN}/" "$FULLNODE_YAML"
	if grep -q '^  num-epochs-to-retain-for-checkpoints:' "$FULLNODE_YAML"; then
		sed -i "s/^  num-epochs-to-retain-for-checkpoints: .*\$/  num-epochs-to-retain-for-checkpoints: ${RETAIN}/" "$FULLNODE_YAML"
	else
		sed -i "/^  num-epochs-to-retain: ${RETAIN}\$/a\\  num-epochs-to-retain-for-checkpoints: ${RETAIN}" "$FULLNODE_YAML"
	fi
fi

exec sui "$@"
