#!/bin/bash
# Walrus storage-node entrypoint for the devstack-rewrite local-cluster
# mode. Adapted from the v3 run-walrus.sh.
#
# Required env (set by container env / docker):
#   HOSTNAME              — provided by docker (matches `dryrun-node-N`).
#   WALRUS_FAUCET_URL     — sui faucet URL reachable from this container.
#                           Defaults to `http://host.docker.internal:9123/v2/gas`
#                           (the current sui-faucet REST endpoint; sui's
#                           legacy `/gas` and `/v1/gas` paths are kept by
#                           the binary but `/v2/gas` is the supported one
#                           per the sui-faucet v2 release). The walrus
#                           plugin sets this env explicitly via
#                           `walrusFaucetUrlInNetwork`; the default is the
#                           fallback for direct `docker run` testing.
#                           `host.docker.internal` resolves on every
#                           platform because the walrus plugin passes
#                           `--add-host host.docker.internal:host-gateway`
#                           on container create (see
#                           `runtime/docker/container.ts::createArgv`).
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

# Faucet + WAL exchange + balance check. `/v2/gas` is the sui-faucet v2
# endpoint (the binary still answers `/v1/gas` and the legacy `/gas` but
# v2 is what new versions ship with).
FAUCET_URL="${WALRUS_FAUCET_URL:-http://host.docker.internal:9123/v2/gas}"

# Wait for DNS to resolve (host.docker.internal can take a beat after
# attach). Bounded to 30s.
FAUCET_HOST=$(echo "$FAUCET_URL" | awk -F[/:] '{print $4}')
echo "run-walrus: waiting for faucet host ${FAUCET_HOST}"
for i in $(seq 1 30); do
	if getent hosts "$FAUCET_HOST" >/dev/null 2>&1; then break; fi
	if [ "$i" -eq 30 ]; then
		echo "run-walrus: faucet host '$FAUCET_HOST' never resolved after 30s" >&2
		exit 1
	fi
	sleep 1
done

echo "run-walrus: requesting SUI gas from ${FAUCET_URL}"
sui client faucet --url "$FAUCET_URL"
sleep 3
if [ -n "${EXCHANGE_OBJECT:-}" ]; then
	echo "run-walrus: requesting WAL from exchange ${EXCHANGE_OBJECT}"
	walrus get-wal --amount 500000000000 || true
fi
echo "run-walrus: checking SUI balance"
sui client balance || true

# Launch walrus-node.
echo "run-walrus: starting walrus-node on ${HOSTNAME}"
exec /opt/walrus/bin/walrus-node run --config-path /root/walrus-node.yaml
