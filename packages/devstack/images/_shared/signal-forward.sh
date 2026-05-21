#!/bin/sh
# Shared signal-forwarding helpers for entrypoint shells that run a
# foreground binary as a non-PID-1 child.
#
# Why: several upstream Rust binaries shipped in the devstack images
# (sui validator, seal key-server) don't register a tokio SIGINT
# handler when run as PID 1, so `docker stop`'s SIGTERM is ignored and
# the grace timeout always expires → SIGKILL → exit 137 → the next
# `up` cycle trips "UNCLEAN PRIOR SHUTDOWN" with a forced recreate.
# Workaround: keep the shell as PID 1 and run the binary as a child;
# the kernel applies SIGINT's default-action terminate to non-PID-1
# children that don't trap it, and the shell can also explicitly
# forward when the binary DOES handle SIGINT (sui without
# --with-faucet, sui-fork) so RocksDB/checkpoint drain runs.
#
# Usage (POSIX-sh / dash compatible):
#
#   . /usr/local/lib/devstack/signal-forward.sh
#
#   <binary> "$@" &
#   CHILD_PID=$!
#   register_signal_forward "$CHILD_PID"
#   wait_for_child "$CHILD_PID"
#   exit "$?"
#
# For an additional sibling child (e.g. sui-faucet alongside sui) call
# `register_signal_forward "$SECONDARY_PID"` again — multiple PIDs are
# tracked and each gets SIGINT on shell signal delivery.

# Newline-separated PID list. POSIX sh has no arrays.
_DEVSTACK_FORWARD_PIDS=""
_DEVSTACK_FORWARD_NL='
'

# Add a PID to the forward list and (idempotently) install the trap.
register_signal_forward() {
	pid="$1"
	if [ -z "$_DEVSTACK_FORWARD_PIDS" ]; then
		_DEVSTACK_FORWARD_PIDS="$pid"
		# shellcheck disable=SC2064
		trap _devstack_forward_int INT TERM
	else
		_DEVSTACK_FORWARD_PIDS="$_DEVSTACK_FORWARD_PIDS$_DEVSTACK_FORWARD_NL$pid"
	fi
}

# Trap body. Delivers SIGINT to every registered PID; suppresses
# already-exited children. Not exported as -f (POSIX sh doesn't have
# function export); sourced into the calling shell so the trap can
# resolve it.
_devstack_forward_int() {
	_saved_ifs=$IFS
	IFS=$_DEVSTACK_FORWARD_NL
	# shellcheck disable=SC2086
	set -- $_DEVSTACK_FORWARD_PIDS
	IFS=$_saved_ifs
	for _pid in "$@"; do
		kill -INT "$_pid" 2>/dev/null || true
	done
}

# Block until the primary child PID is genuinely gone and return its
# exit code via $?. dash's `wait <pid>` returns 128+signum on trapped
# signal delivery even if the child is still alive, so we re-check
# `kill -0` and loop until the kernel has reaped the child.
wait_for_child() {
	pid="$1"
	exit_code=0
	while kill -0 "$pid" 2>/dev/null; do
		wait "$pid"
		exit_code=$?
	done
	return "$exit_code"
}
