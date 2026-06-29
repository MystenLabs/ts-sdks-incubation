#!/bin/bash
# Entrypoint for release-provided Walrus client services.
set -euo pipefail

MODE="${1:-}"
if [ -z "$MODE" ]; then
	echo "run-walrus-client-service: service mode is required" >&2
	exit 2
fi
shift

case "$MODE" in
	aggregator|publisher) ;;
	*)
		echo "run-walrus-client-service: unsupported mode '$MODE'" >&2
		exit 2
		;;
esac

WORKING_DIR="${DEPLOY_OUTPUT_DIR:-/opt/walrus/outputs}"
BIND_ADDRESS="${WALRUS_CLIENT_SERVICE_BIND_ADDRESS:-0.0.0.0:31415}"
CLIENT_CONFIG_SOURCE="$WORKING_DIR/client_config.yaml"
CLIENT_WALLET_SOURCE="$WORKING_DIR/sui_client.yaml"
CLIENT_KEYSTORE_SOURCE="$WORKING_DIR/sui_client.keystore"
CLIENT_CONFIG_TARGET="/root/.config/walrus/client_config.yaml"
CLIENT_WALLET_TARGET="/root/.sui/sui_config/client.yaml"
CLIENT_KEYSTORE_TARGET="/root/.sui/sui_config/sui.keystore"

mkdir -p /root/.sui/sui_config /root/.config/walrus /var/walrus

require_file() {
	local path="$1"
	local label="$2"
	if [ ! -s "$path" ]; then
		echo "run-walrus-client-service: missing ${label} at ${path}" >&2
		exit 3
	fi
}

escape_sed_replacement() {
	printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'
}

require_file "$CLIENT_CONFIG_SOURCE" "Walrus client config"
require_file "$CLIENT_WALLET_SOURCE" "Sui client wallet"
require_file "$CLIENT_KEYSTORE_SOURCE" "Sui client keystore"

echo "run-walrus-client-service: preparing ${MODE} client config from ${WORKING_DIR}"

cp "$CLIENT_CONFIG_SOURCE" "$CLIENT_CONFIG_TARGET"
cp "$CLIENT_WALLET_SOURCE" "$CLIENT_WALLET_TARGET"
cp "$CLIENT_KEYSTORE_SOURCE" "$CLIENT_KEYSTORE_TARGET"

sed -i \
	"s|${CLIENT_KEYSTORE_SOURCE}|${CLIENT_KEYSTORE_TARGET}|g" \
	"$CLIENT_WALLET_TARGET"
if ! grep -Fq "$CLIENT_KEYSTORE_TARGET" "$CLIENT_WALLET_TARGET"; then
	echo "run-walrus-client-service: wallet config did not rewrite keystore path to ${CLIENT_KEYSTORE_TARGET}" >&2
	exit 3
fi
if grep -Fq "$CLIENT_WALLET_SOURCE" "$CLIENT_CONFIG_TARGET"; then
	sed -i \
		"s|${CLIENT_WALLET_SOURCE}|${CLIENT_WALLET_TARGET}|g" \
		"$CLIENT_CONFIG_TARGET"
	if ! grep -Fq "$CLIENT_WALLET_TARGET" "$CLIENT_CONFIG_TARGET"; then
		echo "run-walrus-client-service: Walrus config did not rewrite wallet path to ${CLIENT_WALLET_TARGET}" >&2
		exit 3
	fi
fi

if [ -n "${SUI_RPC_URL:-}" ]; then
	escaped_sui_rpc_url=$(escape_sed_replacement "$SUI_RPC_URL")
	sed -i -E "s|^([[:space:]]*rpc:[[:space:]]*).*$|\\1${escaped_sui_rpc_url}|" \
		"$CLIENT_WALLET_TARGET"
	if ! grep -Fq "rpc: ${SUI_RPC_URL}" "$CLIENT_WALLET_TARGET"; then
		echo "run-walrus-client-service: wallet config did not rewrite rpc to ${SUI_RPC_URL}" >&2
		exit 3
	fi
fi

cmd=(
	/opt/walrus/bin/walrus
	"$MODE"
	--bind-address "$BIND_ADDRESS"
	--config "$CLIENT_CONFIG_TARGET"
	--wallet "$CLIENT_WALLET_TARGET"
)

case "$MODE" in
	aggregator)
		if [ -n "${SUI_RPC_URL:-}" ]; then
			cmd+=(--rpc-url "$SUI_RPC_URL")
		fi
		;;
	publisher)
		sub_wallets_dir="/var/walrus/${MODE}-sub-wallets"
		mkdir -p "$sub_wallets_dir"
		cmd+=(--sub-wallets-dir "$sub_wallets_dir")
		;;
esac

echo "run-walrus-client-service: starting walrus ${MODE} on ${BIND_ADDRESS}"
exec "${cmd[@]}" "$@"
