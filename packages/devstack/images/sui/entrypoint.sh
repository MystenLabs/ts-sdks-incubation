#!/bin/sh
# devstack-rewrite sui-localnet entrypoint.
#
# `sui start --force-regenesis` is ephemeral (in-memory genesis). To
# preserve chain state across `docker stop` + `docker start`, we
# bootstrap once with `sui genesis -f --with-faucet` (writes a
# persistent config dir under /home/devstack-sui/.sui/sui_config) and then run
# `sui start` (no --force-regenesis), which resumes from the on-disk
# state. Chain state lives in the container's writable layer — `docker
# stop`/`start` preserves it; `docker rm` destroys it.
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
# Signal forwarding (clean shutdown). `sui start --with-faucet` has an
# upstream signal-handling bug: `sui_commands.rs:1278`'s
# `start_faucet(app_state).await?` blocks on `axum::serve(...).await`
# BEFORE the post-setup health-check loop installs
# `tokio::signal::ctrl_c()`. So when sui runs with `--with-faucet`, no
# SIGINT handler is ever registered (verified via `/proc/1/status`
# SigCgt = 0x100000440 vs 0x100000442 without `--with-faucet`) and
# `docker stop` falls back to SIGKILL → exit 137 → RocksDB checkpoint
# drain never runs → next `up` resumes from an inconsistent checkpoint
# (observable as walrus storage-node "checkpoint X is below
# lowest-available" errors after restart cycles).
#
# Workaround until the upstream fix lands: strip only `--with-faucet`
# from sui's args and run the standalone `sui-faucet` binary as a
# sibling. Other `sui start` flags, including `--with-graphql`, stay on
# the validator process. Sui without `--with-faucet` reaches its
# ctrl_c-aware loop and exits cleanly on SIGINT. The shell becomes PID
# 1 instead of `exec sui` so it can trap docker's SIGTERM and forward
# SIGINT to both children; sui-faucet has no signal handler of its own
# but as a non-PID-1 child the kernel applies SIGINT's default-action
# terminate, and the faucet is stateless (re-derives everything from
# `~/.sui` on next start).
#
# GraphQL's embedded PostgreSQL indexer refuses to initialize as root,
# so the entrypoint performs setup as PID 1/root and then starts Sui
# plus sui-faucet as the unprivileged `devstack-sui` user. Build helper
# containers override this entrypoint and still run as root.
#
# That embedded PostgreSQL can also leave `postmaster.pid` behind after
# an ungraceful container exit or stale writable-layer reuse. PostgreSQL
# treats that as an active server and aborts before GraphQL binds, so we
# clear only provably-stale pid files before starting Sui.
#
# The trap + wait-loop lives in `/usr/local/lib/devstack/signal-forward.sh`,
# vendored from `images/_shared/signal-forward.sh` at build time —
# the seal key-server entrypoint sources the same file.

set -eu

# shellcheck disable=SC1091
. /usr/local/lib/devstack/signal-forward.sh

SUI_USER="${DEVSTACK_SUI_USER:-devstack-sui}"
SUI_HOME="${DEVSTACK_SUI_HOME:-/home/devstack-sui}"
SUI_UID="$(id -u "$SUI_USER")"
SUI_GID="$(id -g "$SUI_USER")"

mkdir -p "$SUI_HOME/.sui"
chown -R "$SUI_UID:$SUI_GID" "$SUI_HOME"

run_as_sui() {
	setpriv --reuid "$SUI_UID" --regid "$SUI_GID" --init-groups env HOME="$SUI_HOME" "$@"
}

STARTED_PID=""
start_as_sui() {
	setpriv --reuid "$SUI_UID" --regid "$SUI_GID" --init-groups env HOME="$SUI_HOME" "$@" &
	STARTED_PID=$!
}

if [ ! -d "$SUI_HOME/.sui/sui_config" ]; then
	run_as_sui sui genesis -f --with-faucet
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

clear_stale_postgres_pid() {
	indexer_dir="$SUI_HOME/.sui/sui_config/indexer"
	pid_file="$indexer_dir/postmaster.pid"
	[ -f "$pid_file" ] || return 0

	pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
	case "$pid" in
		'' | *[!0-9]*)
			rm -f "$pid_file"
			return 0
			;;
	esac

	if kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	rm -f "$pid_file"
}

clear_stale_postgres_pid

# Strip `--with-faucet[=<addr>]` from sui's args and remember the bind
# address. POSIX-sh argument shuffling: rebuild "$@" by collecting
# everything that isn't the faucet flag, capturing the addr if any.
FAUCET_BIND=""
SUI_ARGV=""
SUI_ARGV_COUNT=0
SAVED_IFS=$IFS
NL='
'
for arg in "$@"; do
	case "$arg" in
		--with-faucet=*)
			FAUCET_BIND="${arg#--with-faucet=}"
			;;
		--with-faucet)
			# Bare flag — use sui's documented localnet faucet default
			# (0.0.0.0:9123). Devstack always passes the `=<addr>` form
			# so this branch is belt-and-suspenders.
			FAUCET_BIND="0.0.0.0:9123"
			;;
		*)
			# Pack into SUI_ARGV using newline as separator (POSIX-sh has
			# no real arrays). Restored via IFS=$NL below.
			if [ "$SUI_ARGV_COUNT" -eq 0 ]; then
				SUI_ARGV="$arg"
			else
				SUI_ARGV="$SUI_ARGV$NL$arg"
			fi
			SUI_ARGV_COUNT=$((SUI_ARGV_COUNT + 1))
			;;
	esac
done

# Re-expand SUI_ARGV into "$@" via IFS so sui sees args without
# `--with-faucet`. Single-element case avoids an empty trailing arg.
IFS=$NL
# shellcheck disable=SC2086
set -- $SUI_ARGV
IFS=$SAVED_IFS

# Start sui in the background. The shell stays PID 1 so it can trap
# docker's SIGTERM and forward; sui becomes a direct child whose
# SIGINT handler the kernel actually delivers (PID 1 ignores
# undelivered signals; non-PID-1 children get them by default).
start_as_sui sui "$@"
SUI_PID=$STARTED_PID
register_signal_forward "$SUI_PID"

# Start sui-faucet as a sibling, scoped to the requested bind addr.
# The faucet reads ~/.sui via `sui_config_dir()` and shares the wallet
# config sui just generated above. Re-derives all in-memory state on
# each start, so signal-induced termination is safe.
FAUCET_PID=""
if [ -n "$FAUCET_BIND" ]; then
	FAUCET_HOST="${FAUCET_BIND%:*}"
	FAUCET_PORT="${FAUCET_BIND##*:}"
	# Wait for sui's gRPC to accept connections on 127.0.0.1:9000
	# before starting the faucet — `LocalFaucet::new` does a wallet
	# `get_reference_gas_price` against the RPC at construction time,
	# and panics with `tcp connect error` if the port isn't accepting
	# yet (`crates/sui-faucet/src/main.rs:25` is `.unwrap()`, no retry
	# loop). curl exits 7 on connection refused; anything else
	# (including gRPC's HTTP/2 garble) means the port is open.
	for _ in $(seq 1 60); do
		# Wrap curl in an `if` branch so its non-zero exit (7 = TCP
		# refused, 28 = timeout — both common while sui is still
		# binding) doesn't trip `set -e` and abort the entrypoint
		# before sui even reaches its RPC bind. Anything OTHER than
		# 7/28 means the TCP port accepted us → sui's gRPC is live
		# enough for `LocalFaucet::new` to succeed.
		if curl -s --max-time 2 --connect-timeout 1 -o /dev/null \
			http://127.0.0.1:9000 2>/dev/null; then
			break
		else
			RC=$?
			if [ "$RC" != "7" ] && [ "$RC" != "28" ]; then
				break
			fi
		fi
		sleep 1
	done
	start_as_sui sui-faucet --host-ip "$FAUCET_HOST" --port "$FAUCET_PORT"
	FAUCET_PID=$STARTED_PID
	register_signal_forward "$FAUCET_PID"
fi

# Wait on sui — it's the primary. The shared helper handles dash's
# "wait returns 128+signum on trapped signal even if child still
# alive" quirk so we report sui's real exit code (and the container
# actually waits for sui's checkpoint flush + RocksDB drain before
# docker reaps it).
SUI_EXIT=0
wait_for_child "$SUI_PID" || SUI_EXIT=$?

# Tear down the faucet if it's still alive (e.g. sui exited on its
# own without the trap firing). SIGKILL because faucet ignores SIGINT
# and we're already in the exit path.
if [ -n "$FAUCET_PID" ]; then
	kill -KILL "$FAUCET_PID" 2>/dev/null || true
	wait "$FAUCET_PID" 2>/dev/null || true
fi

exit "$SUI_EXIT"
