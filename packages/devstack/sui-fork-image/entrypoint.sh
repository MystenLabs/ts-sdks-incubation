#!/bin/sh
# devstack sui-fork entrypoint.
#
# Translates devstack-friendly env vars into `sui-fork start` flags so
# the supervisor can configure the fork via the container's env
# instead of constructing a full argv per invocation:
#
#   SUI_FORK_NETWORK     -> --network <value>     (mainnet/testnet/devnet, default mainnet)
#   SUI_FORK_CHECKPOINT  -> --checkpoint <value>  (optional, latest if unset)
#   SUI_FORK_DATA_DIR    -> --data-dir <value>    (optional, default `~/.local/share/...`)
#   SUI_FORK_SEED_ADDRS  -> --address <a> --address <b> ...   (comma- or space-separated)
#   SUI_FORK_SEED_OBJS   -> --object <id> --object <id> ...   (comma- or space-separated)
#   SUI_FORK_RPC_ADDR    -> --rpc-addr <host:port>            (default 0.0.0.0:9000)
#
# Subcommand defaults to `start` (matches the Dockerfile CMD). Any
# extra args passed to `docker run` after the entrypoint flow through
# at the END of the argv — so callers can override the entrypoint's
# env-derived flags without rebuilding the image.
#
# Bind defaults to 0.0.0.0 (not the upstream's 127.0.0.1) because the
# container is on a per-stack docker network — 127.0.0.1 would refuse
# any peer that joined the same network.

set -eu

SUBCOMMAND="${1:-start}"
shift || true

if [ "$SUBCOMMAND" != "start" ]; then
	# Non-start subcommands (advance-clock, advance-checkpoint, status)
	# don't read SUI_FORK_*; just exec straight through.
	exec sui-fork "$SUBCOMMAND" "$@"
fi

ARGS=""

NETWORK="${SUI_FORK_NETWORK:-mainnet}"
ARGS="$ARGS --network $NETWORK"

if [ -n "${SUI_FORK_CHECKPOINT:-}" ]; then
	ARGS="$ARGS --checkpoint $SUI_FORK_CHECKPOINT"
fi

if [ -n "${SUI_FORK_DATA_DIR:-}" ]; then
	ARGS="$ARGS --data-dir $SUI_FORK_DATA_DIR"
fi

RPC_ADDR="${SUI_FORK_RPC_ADDR:-0.0.0.0:9000}"
ARGS="$ARGS --rpc-addr $RPC_ADDR"

# Seed flags — `sui-fork start` repeats `--address` / `--object` per
# value. Devstack ships a single env var per kind containing a comma-
# or whitespace-separated list; we split and emit one flag per entry.
if [ -n "${SUI_FORK_SEED_ADDRS:-}" ]; then
	IFS=', 	'
	for ADDR in $SUI_FORK_SEED_ADDRS; do
		[ -z "$ADDR" ] && continue
		ARGS="$ARGS --address $ADDR"
	done
	unset IFS
fi

if [ -n "${SUI_FORK_SEED_OBJS:-}" ]; then
	IFS=', 	'
	for OBJ in $SUI_FORK_SEED_OBJS; do
		[ -z "$OBJ" ] && continue
		ARGS="$ARGS --object $OBJ"
	done
	unset IFS
fi

# shellcheck disable=SC2086
exec sui-fork start $ARGS "$@"
