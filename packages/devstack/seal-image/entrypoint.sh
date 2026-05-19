#!/bin/sh
# devstack seal-key-server entrypoint wrapper.
#
# Same workaround as sui-localnet for the same upstream-bug class:
# seal's `key-server` binary (`seal/crates/key-server/src/server.rs:1207`'s
# `#[tokio::main] async fn main`) installs NO signal handler — `main`
# is just `tokio::select! { server_result = axum::serve(...), monitor_result = monitor_handle }`,
# with no `tokio::signal::ctrl_c()` polled on either branch. So running
# the binary as PID 1 in the container, `docker stop`'s SIGTERM is
# ignored (PID 1 default-ignores undelivered signals) and the grace
# timeout always expires → SIGKILL → exit 137 → the next `up` cycle
# trips "UNCLEAN PRIOR SHUTDOWN" with a forced container recreate
# (seal's runc-start fails because the prior shutdown left task state
# behind).
#
# Workaround: run key-server as a non-PID-1 CHILD of this shell. The
# shell traps docker's SIGTERM and forwards SIGINT to the child;
# non-PID-1 processes follow the kernel's default action for signals
# they don't trap, and default-action for SIGINT is "Term" — the
# process exits cleanly (exit 130 = 128+2), not 137. Seal's runtime
# state is in-memory only (master key cached, sessions reload on
# restart), so signal-induced termination is safe — the next start
# reads MASTER_KEY from env again and recomputes everything.
#
# The keygen path (`docker run --entrypoint seal-cli ... genkey`)
# bypasses this entrypoint entirely via `--entrypoint` override, so
# the wrapping only affects the long-running key-server container.
set -eu

/usr/local/bin/key-server "$@" &
KS_PID=$!

# Forward docker's SIGTERM (and a passthrough SIGINT) to the
# key-server child. Trap fires on shell signal delivery; default
# action for the child's SIGINT is terminate, so the child dies.
forward_int() {
	kill -INT "$KS_PID" 2>/dev/null || true
}
trap forward_int INT TERM

# Wait loop. `wait` in dash returns 128+signum when interrupted by a
# trapped signal even if the child is still alive — so re-check
# `kill -0` and loop until the child PID is truly gone.
KS_EXIT=0
while kill -0 "$KS_PID" 2>/dev/null; do
	wait "$KS_PID"
	KS_EXIT=$?
done

exit "$KS_EXIT"
