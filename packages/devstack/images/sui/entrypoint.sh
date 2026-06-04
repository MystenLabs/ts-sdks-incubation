#!/bin/sh
# devstack-rewrite sui-localnet entrypoint.
#
# `sui start --force-regenesis` is ephemeral (in-memory genesis). To
# preserve chain state across `docker stop` + `docker start`, we
# bootstrap once with `sui genesis -f --with-faucet` (writes a
# persistent config dir under $SUI_HOME/.sui/sui_config) and then run
# `sui start` (no --force-regenesis), which resumes from the on-disk
# state. Chain state lives in the container's writable layer — `docker
# stop`/`start` preserves it; `docker rm` destroys it. The pinned
# sui-tools base carries the embedded-fullnode resume fix (#26884) and
# the `--with-faucet` ctrl-c fix, so sui runs as PID 1 with native
# signal handling — no signal-forwarding shim or fullnode-db prune.
#
# Slow checkpoint pruning. Localnet's stock fullnode.yaml ships with
# `num-epochs-to-retain: 0`, which prunes checkpoints aggressively
# (~10 minutes of retention on a fresh chain). Downstream consumers
# that follow the chain sequentially (e.g. walrus storage nodes via
# the v2 LedgerService `get_full_checkpoint` gRPC) get permanently
# stuck once their last-processed checkpoint slips below sui's
# lowest-available-checkpoint. Default retention here is 2 prior
# epochs (~48–72h at the localnet's default 24h epoch); override via
# the `DEVSTACK_SUI_EPOCHS_TO_RETAIN` env var (`MAX` disables pruning).
#
# External indexer + GraphQL gate. sui-tools has no embedded Postgres,
# so GraphQL's indexer reads from an external DB. When
# `DEVSTACK_SUI_INDEXER_URL` (a PostgreSQL DSN reaching the devstack
# postgres plugin via its network alias) is set, the entrypoint appends
# `--with-graphql` + `--with-indexer=<dsn>`. Unset = RPC + faucet only.

set -eu

SUI_HOME="${DEVSTACK_SUI_HOME:-/root}"
mkdir -p "$SUI_HOME/.sui"

if [ ! -d "$SUI_HOME/.sui/sui_config" ]; then
	sui genesis -f --with-faucet
fi

RETAIN_RAW="${DEVSTACK_SUI_EPOCHS_TO_RETAIN:-2}"
if [ "$RETAIN_RAW" = "MAX" ]; then
	RETAIN=18446744073709551615
else
	RETAIN="$RETAIN_RAW"
fi
patch_pruning_config() {
	config_file="$1"
	[ -f "$config_file" ] || return 0
	grep -q 'authority-store-pruning-config:' "$config_file" || return 0

	# Idempotent rewrite — covers volumes that pre-date this fix. `sui
	# start` reads network.yaml / per-validator YAMLs, while fullnode.yaml
	# is not the only live config file on localnet.
	sed -i -E "s/^([[:space:]]*)num-epochs-to-retain: .*\$/\\1num-epochs-to-retain: ${RETAIN}/" "$config_file"
	if grep -q '^[[:space:]]*num-epochs-to-retain-for-checkpoints:' "$config_file"; then
		sed -i -E "s/^([[:space:]]*)num-epochs-to-retain-for-checkpoints: .*\$/\\1num-epochs-to-retain-for-checkpoints: ${RETAIN}/" "$config_file"
	else
		awk -v retain="$RETAIN" '
			/^[[:space:]]*num-epochs-to-retain: / {
				print
				match($0, /^[[:space:]]*/)
				indent = substr($0, RSTART, RLENGTH)
				print indent "num-epochs-to-retain-for-checkpoints: " retain
				next
			}
			{ print }
		' "$config_file" > "${config_file}.tmp"
		mv "${config_file}.tmp" "$config_file"
	fi
}

for config_file in "$SUI_HOME"/.sui/sui_config/*.yaml; do
	patch_pruning_config "$config_file"
done

# Gate GraphQL + wire the external indexer DSN, if supplied.
if [ -n "${DEVSTACK_SUI_INDEXER_URL:-}" ]; then
	set -- "$@" --with-graphql=0.0.0.0:9125 --with-indexer="$DEVSTACK_SUI_INDEXER_URL"
fi

exec sui "$@"
