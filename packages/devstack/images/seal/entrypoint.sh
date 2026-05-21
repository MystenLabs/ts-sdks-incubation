#!/bin/sh
# devstack-rewrite seal-key-server entrypoint wrapper.
#
# Same workaround as sui-localnet for the same upstream-bug class:
# seal's `key-server` binary (`seal/crates/key-server/src/server.rs`'s
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
# Master-key staging: the plugin bind-mounts a 0o600 env-file at
# /etc/seal/master-key.env containing `MASTER_KEY=<hex>`. We source
# it BEFORE exec'ing the key-server so the secret lands in the
# child's environment, NEVER in `docker inspect` / host process
# env. Distilled-doc invariant #3.
#
# The keygen path (`runOneShot({ entrypoint: 'seal-cli', argv: ['genkey'] })`)
# bypasses this entrypoint entirely via the runtime's --entrypoint
# override, so the wrapping only affects the long-running key-server
# container.
#
# The trap + wait-loop lives in `/usr/local/lib/devstack/signal-forward.sh`,
# vendored from `images/_shared/signal-forward.sh` at build time —
# the sui entrypoint sources the same file.

set -eu

# shellcheck disable=SC1091
. /usr/local/lib/devstack/signal-forward.sh

# Source the master-key env-file if it's present at the well-known
# bind-mount path. `set -a` exports every VAR=value pair to the
# child process environment. Idempotent: if the file is absent,
# we fall through with no error (the binary will fail with its own
# typed message, which is the right level of detail for callers).
if [ -r /etc/seal/master-key.env ]; then
	set -a
	# shellcheck disable=SC1091
	. /etc/seal/master-key.env
	set +a
fi

/usr/local/bin/key-server "$@" &
KS_PID=$!
register_signal_forward "$KS_PID"

KS_EXIT=0
wait_for_child "$KS_PID" || KS_EXIT=$?

exit "$KS_EXIT"
