#!/bin/bash
# Walrus testbed deploy script. Forked from MystenLabs/walrus's
# `docker/local-testbed/files/deploy-walrus.sh` and informed by their
# canonical procman config (https://wbbradley.github.io/procman/).
#
# Owned in-tree so we don't depend on the walrus repo's
# `docker/local-testbed/` layout (the walrus team is migrating their
# canonical local-testbed flow to procman; the bash files we used to
# fetch via BuildKit context may go away). Inputs are env vars only —
# no CLI args; the caller (`walrus.deploy` action) sets WALRUS_*.
#
# Required env (set by walrus.deploy action's container env):
#   WALRUS_PUBLIC_HOSTS    — space-separated list of N storage-node
#                             public hostnames (one per committee
#                             member). These are passed to walrus-deploy
#                             as `--host-addresses` and end up in the
#                             on-chain Committee `network_address`.
#                             N defines COMMITTEE_SIZE; mismatch with
#                             WALRUS_COMMITTEE_SIZE fails fast.
#   WALRUS_LISTENING_IPS   — space-separated list of N internal docker
#                             IPs the storage nodes bind their REST API
#                             on. Passed to walrus-deploy as
#                             `--listening-ips` so binding is decoupled
#                             from the on-chain `public_host`.
# Optional:
#   WALRUS_REST_API_PORT   — REST API port. Used both as on-chain
#                             `public_port` and as the bind port for
#                             every node (default 9185).
#   WALRUS_COMMITTEE_SIZE  — committee size (default: count of
#                             WALRUS_PUBLIC_HOSTS).
#   WALRUS_SHARDS          — total shards (default 100). Must be >=
#                             COMMITTEE_SIZE.
#   WALRUS_EPOCH_DURATION  — walrus epoch (default 24h).
#   WALRUS_NETWORK         — sui network mode passed to walrus-deploy
#                             (default 'http://sui-localnet:9000;http://sui-localnet:9123/gas',
#                             the per-stack docker DNS pointing at the
#                             sui-localnet container).
#   WALRUS_CONTRACT_DIR    — Move contract dir baked into the image
#                             (default /opt/walrus/contracts).
#   WALRUS_GC              — 'true' enables blob GC config (default
#                             unset = false).
set -euo pipefail

WALRUS_DEPLOY_BIN="${WALRUS_DEPLOY_BIN:-/opt/walrus/bin/walrus-deploy}"
WORKING_DIR="${WORKING_DIR:-/opt/walrus/outputs}"
WALRUS_CONTRACT_DIR="${WALRUS_CONTRACT_DIR:-/opt/walrus/contracts}"
SHARDS="${WALRUS_SHARDS:-100}"
EPOCH_DURATION="${WALRUS_EPOCH_DURATION:-24h}"
NETWORK="${WALRUS_NETWORK:-http://sui-localnet:9000;http://sui-localnet:9123/gas}"
GC="${WALRUS_GC:-false}"
REST_API_PORT="${WALRUS_REST_API_PORT:-9185}"

if [ -z "${WALRUS_PUBLIC_HOSTS:-}" ]; then
	echo "deploy-walrus: WALRUS_PUBLIC_HOSTS is required (space-separated hostnames)" >&2
	exit 1
fi
if [ -z "${WALRUS_LISTENING_IPS:-}" ]; then
	echo "deploy-walrus: WALRUS_LISTENING_IPS is required (space-separated docker IPs)" >&2
	exit 1
fi
read -r -a PUBLIC_HOSTS <<< "$WALRUS_PUBLIC_HOSTS"
read -r -a LISTENING_IPS <<< "$WALRUS_LISTENING_IPS"
COMMITTEE_SIZE="${WALRUS_COMMITTEE_SIZE:-${#PUBLIC_HOSTS[@]}}"

if [ "${#PUBLIC_HOSTS[@]}" -ne "$COMMITTEE_SIZE" ]; then
	echo "deploy-walrus: WALRUS_PUBLIC_HOSTS has ${#PUBLIC_HOSTS[@]} entries but WALRUS_COMMITTEE_SIZE=$COMMITTEE_SIZE" >&2
	exit 1
fi
if [ "${#LISTENING_IPS[@]}" -ne "$COMMITTEE_SIZE" ]; then
	echo "deploy-walrus: WALRUS_LISTENING_IPS has ${#LISTENING_IPS[@]} entries but WALRUS_COMMITTEE_SIZE=$COMMITTEE_SIZE" >&2
	exit 1
fi
if ! [ "$COMMITTEE_SIZE" -gt 0 ] 2>/dev/null; then
	echo "deploy-walrus: COMMITTEE_SIZE=$COMMITTEE_SIZE must be a positive integer" >&2
	exit 1
fi
if ! [ "$SHARDS" -ge "$COMMITTEE_SIZE" ] 2>/dev/null; then
	echo "deploy-walrus: SHARDS=$SHARDS must be >= COMMITTEE_SIZE=$COMMITTEE_SIZE" >&2
	exit 1
fi

# Clean stale build artifacts + any previous deploy outputs. Matches the
# walrus team's procman config — fresh deploy each cycle.
find "$WALRUS_CONTRACT_DIR" -name 'build' -type d -exec rm -rf {} +
rm -f "$WORKING_DIR"/dryrun-node-*.yaml "$WORKING_DIR"/dryrun-node-*.log

"$WALRUS_DEPLOY_BIN" deploy-system-contract \
	--working-dir "$WORKING_DIR" \
	--contract-dir "$WALRUS_CONTRACT_DIR" \
	--do-not-copy-contracts \
	--sui-network "$NETWORK" \
	--n-shards "$SHARDS" \
	--host-addresses "${PUBLIC_HOSTS[@]}" \
	--rest-api-port "$REST_API_PORT" \
	--storage-price 5 \
	--write-price 1 \
	--epoch-duration "$EPOCH_DURATION" \
	--with-wal-exchange \
	> "$WORKING_DIR/deploy"

"$WALRUS_DEPLOY_BIN" generate-dry-run-configs \
	--working-dir "$WORKING_DIR" \
	--listening-ips "${LISTENING_IPS[@]}"

# Append event-processor + storage_path + tls-disable + optional GC to
# every generated node yaml. Order:
#   1. event_processor_config — walrus team's procman default; we adopt
#      it for parity.
#   2. storage_path — point at the container writable layer instead of
#      the read-only outputs bind so RocksDB writes succeed.
#   3. tls.disable_tls — workaround for axum-server 0.8.0 panic on
#      arm64-darwin self-signed handshake (see notes/friction.md). The
#      per-stack walrus.proxy nginx terminates host-facing access, so
#      plain HTTP between nodes is fine inside the docker network.
#   4. db_config + garbage_collection — opt-in via WALRUS_GC=true.
for f in "$WORKING_DIR"/dryrun-node-*[0-9].yaml; do
	# Redirect storage_path before appending so the sed targets the
	# upstream-generated line, not anything we appended.
	sed -i "s|^storage_path: ${WORKING_DIR}/|storage_path: /var/walrus/storage/|" "$f"
	cat >> "$f" <<-NODEEOF

	event_processor_config:
	  adaptive_downloader_config:
	    max_workers: 2
	    initial_workers: 2
	tls:
	  disable_tls: true
	NODEEOF
	if [ "$GC" = "true" ]; then
		cat >> "$f" <<-GCEOF
		db_config:
		  global:
		    experimental_use_optimistic_transaction_db: true
		garbage_collection:
		  enable_blob_info_cleanup: true
		  enable_data_deletion: true
		GCEOF
	fi
done
