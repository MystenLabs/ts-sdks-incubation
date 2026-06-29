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
WALLET_NODE="${WALRUS_CLIENT_WALLET_NODE:-dryrun-node-0}"
BIND_ADDRESS="${WALRUS_CLIENT_SERVICE_BIND_ADDRESS:-0.0.0.0:31415}"

mkdir -p /root/.sui/sui_config /root/.config/walrus /var/walrus

echo "run-walrus-client-service: preparing ${MODE} wallet ${WALLET_NODE} from ${WORKING_DIR}"

cp "$WORKING_DIR/${WALLET_NODE}.keystore" /root/.sui/sui_config/sui.keystore
cp "$WORKING_DIR/${WALLET_NODE}-sui.yaml" /root/.sui/sui_config/client.yaml

sed -i \
	"s|${WORKING_DIR}/${WALLET_NODE}.keystore|/root/.sui/sui_config/sui.keystore|" \
	/root/.sui/sui_config/client.yaml 2>/dev/null || true

if [ -n "${SUI_RPC_URL:-}" ]; then
	sed -i -E "s|^([[:space:]]*rpc:[[:space:]]*).*$|\\1${SUI_RPC_URL}|" \
		/root/.sui/sui_config/client.yaml 2>/dev/null || true
fi

SYSTEM_OBJECT=$(grep '^system_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
STAKING_OBJECT=$(grep '^staking_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
EXCHANGE_OBJECT=$(grep '^exchange_object:' "$WORKING_DIR/deploy" | awk '{print $2}' || true)

cat > /root/.config/walrus/client_config.yaml <<EOF
system_object: ${SYSTEM_OBJECT}
staking_object: ${STAKING_OBJECT}
EOF
if [ -n "${EXCHANGE_OBJECT:-}" ] && [ "$EXCHANGE_OBJECT" != "None" ]; then
	echo "exchange_objects: [${EXCHANGE_OBJECT}]" >> /root/.config/walrus/client_config.yaml
fi

cmd=(
	/opt/walrus/bin/walrus
	"$MODE"
	--bind-address "$BIND_ADDRESS"
	--config /root/.config/walrus/client_config.yaml
	--wallet /root/.sui/sui_config/client.yaml
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
