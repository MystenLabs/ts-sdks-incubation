#!/bin/sh
# Devstack-managed sui-localnet entrypoint.
#
# Walrus's local testbed expects a sibling sui-localnet container that
# shares its `sui` binary via a Docker volume mounted at /sui-bin. When
# walrus is in the compose, devstack attaches that volume here; otherwise
# the directory either doesn't exist or isn't writable, and we no-op.
#
# Persistence: `sui start --force-regenesis` runs an ephemeral network
# (in-memory genesis). To preserve chain state across `docker stop` +
# `docker start`, we bootstrap once with `sui genesis -f --with-faucet`
# (writes a persistent config dir to /root/.sui/sui_config) and then run
# `sui start` (no --force-regenesis), which resumes from the on-disk
# state. The named volume mounted at /root/.sui carries the chain
# forward.
set -eu

if [ -d /sui-bin ] && [ -w /sui-bin ]; then
	cp -f /usr/local/bin/sui /sui-bin/sui
fi

mkdir -p /root/.sui

# Bootstrap genesis once per volume. `sui genesis` exits after writing
# the config; subsequent starts read it back.
if [ ! -d /root/.sui/sui_config ]; then
	sui genesis -f --with-faucet
fi

# Strip --force-regenesis if it slipped in (legacy CMD compatibility).
# We always want resume-from-disk now that genesis is persistent.
args=""
for a in "$@"; do
	case "$a" in
		--force-regenesis) ;;
		*) args="$args $a" ;;
	esac
done
# shellcheck disable=SC2086
exec sui $args
