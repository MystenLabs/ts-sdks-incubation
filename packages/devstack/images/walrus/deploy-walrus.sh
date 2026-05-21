#!/bin/bash
# Walrus testbed deploy script for the devstack-rewrite local-cluster
# mode. Reads CLI flags (NOT env vars — that's the v3 contract; the
# rewrite passes flags from `plugins/walrus/deploy.ts::runDeployOneShot`).
#
# Required flags (passed by deploy.ts):
#   --output-dir DIR         — working dir for deploy outputs.
#   --committee-size N       — N storage nodes in the committee.
#   --shards N               — total shards (must be >= committee-size).
#   --epoch-duration D       — walrus epoch duration (e.g. 24h).
#   --sui-rpc-url URL        — sui RPC endpoint reachable from this
#                               container (host.docker.internal).
#   --faucet-url URL         — sui faucet endpoint (same host).
#   --public-hosts CSV       — comma-separated public hostnames (one
#                               per node) used in on-chain Committee.
#   --listening-ips CSV      — comma-separated bind IPs (one per node).
#
# Optional flags:
#   --gc                     — append a `db_config` + `garbage_collection`
#                               block to every generated dryrun-node yaml
#                               so blob GC + data deletion run inside the
#                               storage node. Relevant for plugin authors
#                               testing storage-node cleanup; off by
#                               default (matches procman's default).
#
# Outputs (under --output-dir):
#   - deploy                       — summary file walrus-deploy emits.
#                                    Contains `walrus_package_id:`,
#                                    `system_object:`, `staking_object:`,
#                                    `exchange_object:` etc.
#   - dryrun-node-<i>.yaml         — per-node walrus-node config.
#   - dryrun-node-<i>.keystore     — per-node sui keystore.
#   - dryrun-node-<i>-sui.yaml     — per-node sui client config.
#
# Stdout MUST include the deploy summary in `key: 0x<hex>` format
# (plugins/walrus/deploy.ts::parseDeployOutput regexes pick these out).
set -euo pipefail

WORKING_DIR=""
COMMITTEE_SIZE=""
SHARDS=100
EPOCH_DURATION="24h"
SUI_RPC_URL=""
FAUCET_URL=""
PUBLIC_HOSTS_CSV=""
LISTENING_IPS_CSV=""
GC=false

while [ $# -gt 0 ]; do
	case "$1" in
		--output-dir) WORKING_DIR="$2"; shift 2 ;;
		--committee-size) COMMITTEE_SIZE="$2"; shift 2 ;;
		--shards) SHARDS="$2"; shift 2 ;;
		--epoch-duration) EPOCH_DURATION="$2"; shift 2 ;;
		--sui-rpc-url) SUI_RPC_URL="$2"; shift 2 ;;
		--faucet-url) FAUCET_URL="$2"; shift 2 ;;
		--public-hosts) PUBLIC_HOSTS_CSV="$2"; shift 2 ;;
		--listening-ips) LISTENING_IPS_CSV="$2"; shift 2 ;;
		--gc) GC=true; shift 1 ;;
		*) echo "deploy-walrus: unknown arg '$1'" >&2; exit 2 ;;
	esac
done

[ -n "$WORKING_DIR" ] || { echo "deploy-walrus: --output-dir is required" >&2; exit 1; }
[ -n "$COMMITTEE_SIZE" ] || { echo "deploy-walrus: --committee-size is required" >&2; exit 1; }
[ -n "$SUI_RPC_URL" ] || { echo "deploy-walrus: --sui-rpc-url is required" >&2; exit 1; }
[ -n "$FAUCET_URL" ] || { echo "deploy-walrus: --faucet-url is required" >&2; exit 1; }
[ -n "$PUBLIC_HOSTS_CSV" ] || { echo "deploy-walrus: --public-hosts is required" >&2; exit 1; }
[ -n "$LISTENING_IPS_CSV" ] || { echo "deploy-walrus: --listening-ips is required" >&2; exit 1; }

IFS=',' read -r -a PUBLIC_HOSTS <<< "$PUBLIC_HOSTS_CSV"
IFS=',' read -r -a LISTENING_IPS <<< "$LISTENING_IPS_CSV"

if [ "${#PUBLIC_HOSTS[@]}" -ne "$COMMITTEE_SIZE" ]; then
	echo "deploy-walrus: --public-hosts has ${#PUBLIC_HOSTS[@]} entries but --committee-size=$COMMITTEE_SIZE" >&2
	exit 1
fi
if [ "${#LISTENING_IPS[@]}" -ne "$COMMITTEE_SIZE" ]; then
	echo "deploy-walrus: --listening-ips has ${#LISTENING_IPS[@]} entries but --committee-size=$COMMITTEE_SIZE" >&2
	exit 1
fi
if ! [ "$SHARDS" -ge "$COMMITTEE_SIZE" ] 2>/dev/null; then
	echo "deploy-walrus: --shards=$SHARDS must be >= --committee-size=$COMMITTEE_SIZE" >&2
	exit 1
fi

WALRUS_DEPLOY_BIN="${WALRUS_DEPLOY_BIN:-/opt/walrus/bin/walrus-deploy}"
WALRUS_CONTRACT_DIR="${WALRUS_CONTRACT_DIR:-/opt/walrus/contracts}"
SUI_BIN="${SUI_BIN:-/root/sui_bin/sui}"

if [ ! -x "$WALRUS_DEPLOY_BIN" ]; then
	echo "deploy-walrus: walrus-deploy binary is missing or not executable at $WALRUS_DEPLOY_BIN" >&2
	exit 127
fi
if [ ! -x "$SUI_BIN" ]; then
	echo "deploy-walrus: sui binary is missing or not executable at $SUI_BIN" >&2
	exit 127
fi

mkdir -p "$WORKING_DIR"

# Clean stale build artifacts + previous deploy outputs (fresh deploy each
# cycle — the OCA cache-key drives "is this a re-run" decision).
[ -d "$WALRUS_CONTRACT_DIR" ] && find "$WALRUS_CONTRACT_DIR" -name 'build' -type d -exec rm -rf {} + || true
rm -f "$WORKING_DIR"/dryrun-node-*.yaml "$WORKING_DIR"/dryrun-node-*.log

# Pre-create admin wallet so sui-cli picks up the right active_env name
# (walrus-deploy's wallet-loading path needs `localnet`, not `custom`).
ADMIN_WALLET_YAML="$WORKING_DIR/sui_admin.yaml"
ADMIN_KEYSTORE="$WORKING_DIR/sui_admin.keystore"

export HOME="$WORKING_DIR/.suihome"
rm -rf "$HOME"
mkdir -p "$HOME/.sui/sui_config"

"$SUI_BIN" client new-address ed25519 admin --json > /dev/null
"$SUI_BIN" client new-env --alias localnet --rpc "$SUI_RPC_URL" > /dev/null
"$SUI_BIN" client switch --env localnet > /dev/null
"$SUI_BIN" client switch --address admin > /dev/null

ADMIN_ADDR=$("$SUI_BIN" client active-address)
if [ "${ADMIN_ADDR#0x}" = "$ADMIN_ADDR" ]; then
	echo "deploy-walrus: failed to resolve admin address from sui client (got '$ADMIN_ADDR')" >&2
	exit 1
fi

cp "$HOME/.sui/sui_config/sui.keystore" "$ADMIN_KEYSTORE"
sed -e "s|$HOME/.sui/sui_config/sui.keystore|$ADMIN_KEYSTORE|" \
	"$HOME/.sui/sui_config/client.yaml" > "$ADMIN_WALLET_YAML"

# Faucet the admin so the publish has gas.
echo "deploy-walrus: faucet → $ADMIN_ADDR ($FAUCET_URL)"
FAUCET_RESPONSE=$(curl -fsS -X POST \
	-H 'Content-Type: application/json' \
	-d "{\"FixedAmountRequest\":{\"recipient\":\"$ADMIN_ADDR\"}}" \
	"$FAUCET_URL")
echo "deploy-walrus: faucet response: ${FAUCET_RESPONSE:0:200}..."

# Poll balance until faucet's coins settle.
echo "deploy-walrus: polling for admin balance to settle"
BALANCE=0
for i in $(seq 1 30); do
	BALANCE_JSON=$(curl -fsS -X POST \
		-H 'Content-Type: application/json' \
		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getBalance\",\"params\":[\"$ADMIN_ADDR\"]}" \
		"$SUI_RPC_URL" || echo '{}')
	BALANCE=$(echo "$BALANCE_JSON" | grep -oE '"totalBalance":"[0-9]+"' | head -1 | grep -oE '[0-9]+' || echo "0")
	if [ -n "$BALANCE" ] && [ "$BALANCE" -gt 0 ] 2>/dev/null; then
		echo "deploy-walrus: admin balance settled at $BALANCE MIST after ${i} polls"
		break
	fi
	sleep 1
done
if [ -z "$BALANCE" ] || ! [ "$BALANCE" -gt 0 ] 2>/dev/null; then
	echo "deploy-walrus: admin balance still 0 after 30s — faucet drip likely failed" >&2
	exit 1
fi

# Build the walrus-deploy network arg (rpc;faucet form).
WALRUS_NETWORK_ARG="${SUI_RPC_URL};${FAUCET_URL}"

# Run walrus-deploy. The contract dir is baked into the image at
# /opt/walrus/contracts (placed there during the upstream image build —
# but since the release tarball doesn't ship contracts, we fall back to
# `--package-path` once the move-source sibling is wired. For now we
# rely on `--do-not-copy-contracts` and the in-image contract bundle.)
"$WALRUS_DEPLOY_BIN" deploy-system-contract \
	--working-dir "$WORKING_DIR" \
	--admin-wallet-path "$ADMIN_WALLET_YAML" \
	--contract-dir "$WALRUS_CONTRACT_DIR" \
	--do-not-copy-contracts \
	--sui-network "$WALRUS_NETWORK_ARG" \
	--n-shards "$SHARDS" \
	--host-addresses "${PUBLIC_HOSTS[@]}" \
	--rest-api-port 9185 \
	--storage-price 5 \
	--write-price 1 \
	--epoch-duration "$EPOCH_DURATION" \
	--with-wal-exchange \
	| tee "$WORKING_DIR/deploy"

"$WALRUS_DEPLOY_BIN" generate-dry-run-configs \
	--working-dir "$WORKING_DIR" \
	--listening-ips "${LISTENING_IPS[@]}"

# Patch generated node configs: storage_path → writable layer, rebind on
# 0.0.0.0, disable TLS (in-network plain HTTP behind router), optionally
# enable blob GC + data deletion when --gc was passed.
for f in "$WORKING_DIR"/dryrun-node-*[0-9].yaml; do
	sed -i "s|^storage_path: ${WORKING_DIR}/|storage_path: /var/walrus/storage/|" "$f"
	sed -i -E "s|^(rest_api_address): [0-9.]+:|\\1: 0.0.0.0:|" "$f"
	sed -i -E "s|^(metrics_address): [0-9.]+:|\\1: 0.0.0.0:|" "$f"
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

# Re-emit the deploy summary on stdout so the rewrite's
# `parseDeployOutput` regexes (which match `key: 0x<hex>` lines) pick
# up the system/staking/exchange ids. walrus-deploy already writes them
# to $WORKING_DIR/deploy; we just `cat` here so they're on stdout too.
echo ""
echo "==== deploy-walrus summary ===="
cat "$WORKING_DIR/deploy"
