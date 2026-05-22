#!/bin/bash
# Walrus storage-node entrypoint for the devstack-rewrite local-cluster
# mode. Adapted from the v3 run-walrus.sh.
#
# Required env (set by container env / docker):
#   HOSTNAME              — provided by docker (matches `dryrun-node-N`).
set -euo pipefail

mkdir -p /root/.sui/sui_config /var/walrus
WORKING_DIR="${DEPLOY_OUTPUT_DIR:-/opt/walrus/outputs}"

echo "run-walrus: preparing ${HOSTNAME} config from ${WORKING_DIR}"

# Relocate per-node sui keystore + yaml configs out of /opt/walrus/outputs
# (read-only mount on macOS Docker; osxfs/gRPC-fuse return ENOTSUP for
# keystore lock/write ops the sui SDK performs during transaction signing).
cp "$WORKING_DIR/${HOSTNAME}.keystore" /root/.sui/sui_config/sui.keystore
cp "$WORKING_DIR/${HOSTNAME}-sui.yaml" /root/walrus-sui.yaml
cp "$WORKING_DIR/${HOSTNAME}.yaml" /root/walrus-node.yaml

# Rewrite path references inside relocated copies.
sed -i \
	"s|${WORKING_DIR}/${HOSTNAME}.keystore|/root/.sui/sui_config/sui.keystore|" \
	/root/walrus-sui.yaml 2>/dev/null || true

sed -i \
	-e "s|wallet_config: ${WORKING_DIR}/${HOSTNAME}-sui.yaml|wallet_config: /root/walrus-sui.yaml|" \
	-e "s|admin_socket_path: ${WORKING_DIR}/|admin_socket_path: /var/walrus/|" \
	/root/walrus-node.yaml

# sui CLI client config pointing at relocated keystore + active address.
cp "$WORKING_DIR/${HOSTNAME}-sui.yaml" /root/.sui/sui_config/client.yaml
sed -i \
	"s|${WORKING_DIR}/${HOSTNAME}.keystore|/root/.sui/sui_config/sui.keystore|" \
	/root/.sui/sui_config/client.yaml

# walrus CLI client config pointing at deployed system/staking/exchange.
mkdir -p /root/.config/walrus
SYSTEM_OBJECT=$(grep '^system_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
STAKING_OBJECT=$(grep '^staking_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
EXCHANGE_OBJECT=$(grep '^exchange_object:' "$WORKING_DIR/deploy" | awk '{print $2}' || true)

cat > /root/.config/walrus/client_config.yaml <<EOF
system_object: ${SYSTEM_OBJECT}
staking_object: ${STAKING_OBJECT}
EOF
if [ -n "${EXCHANGE_OBJECT:-}" ]; then
	echo "exchange_objects: [${EXCHANGE_OBJECT}]" >> /root/.config/walrus/client_config.yaml
fi

# Launch walrus-node.
echo "run-walrus: starting walrus-node on ${HOSTNAME}"
exec /opt/walrus/bin/walrus-node run --config-path /root/walrus-node.yaml
