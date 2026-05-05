#!/bin/bash
# Walrus storage-node entrypoint. Forked from MystenLabs/walrus's
# `docker/local-testbed/files/run-walrus.sh` — owned in-tree to drop
# our 5+ sed patches against the upstream version (and to be resilient
# to upstream restructuring as walrus migrates to procman). Inputs are
# env vars; the caller is the per-node container's entrypoint.
#
# What this script does:
#   1. Relocate the per-node sui keystore + yaml configs out of
#      /opt/walrus/outputs (read-only bind on macOS Docker; osxfs +
#      gRPC-fuse return ENOTSUP for keystore lock/write ops the sui
#      SDK performs during transaction signing) into /root/* (writable
#      layer).
#   2. Rewrite path references inside the relocated yamls so sui SDK
#      resolves the relocated keystore.
#   3. Faucet some SUI for the node, swap for WAL via the exchange,
#      print balance.
#   4. Launch `walrus-node run` against the relocated yaml.
#
# Required env (set by container env / image baked-in):
#   HOSTNAME — provided by docker (matches `dryrun-node-N`).
set -euo pipefail

mkdir -p /root/.sui/sui_config /var/walrus
WORKING_DIR=/opt/walrus/outputs

# The image bakes the `sui` binary at /root/sui_bin/sui (wrapper layer)
# and the walrus binaries at /opt/walrus/bin/. Surface them on PATH so
# the `sui client …` and `walrus get-wal …` invocations below work
# without absolute paths — matches what upstream's run-walrus.sh
# expected (it copied sui into /usr/local/bin from a shared volume).
cp /root/sui_bin/sui /usr/local/bin/sui
cp /opt/walrus/bin/walrus /usr/local/bin/walrus

# Step 1: relocate keystore + yamls.
cp "$WORKING_DIR/${HOSTNAME}.keystore" /root/.sui/sui_config/sui.keystore
cp "$WORKING_DIR/${HOSTNAME}-sui.yaml" /root/walrus-sui.yaml
cp "$WORKING_DIR/${HOSTNAME}.yaml" /root/walrus-node.yaml

# Step 2: rewrite path references inside the relocated copies.
sed -i \
	"s|${WORKING_DIR}/${HOSTNAME}.keystore|/root/.sui/sui_config/sui.keystore|" \
	/root/.sui/sui_config/client.yaml \
	/root/walrus-sui.yaml 2>/dev/null || true

# walrus-node.yaml's wallet_config points at the per-node sui yaml; the
# admin_socket_path defaults to the read-only outputs dir which would
# fail with EROFS on socket creation — relocate to /var/walrus.
sed -i \
	-e "s|wallet_config: ${WORKING_DIR}/${HOSTNAME}-sui.yaml|wallet_config: /root/walrus-sui.yaml|" \
	-e "s|admin_socket_path: ${WORKING_DIR}/|admin_socket_path: /var/walrus/|" \
	/root/walrus-node.yaml

# Also drop a /root/.sui/sui_config/client.yaml so the sui CLI in this
# container picks up the relocated keystore + active address.
cp "$WORKING_DIR/${HOSTNAME}-sui.yaml" /root/.sui/sui_config/client.yaml
sed -i \
	"s|${WORKING_DIR}/${HOSTNAME}.keystore|/root/.sui/sui_config/sui.keystore|" \
	/root/.sui/sui_config/client.yaml

# `walrus get-wal` (called below) needs a client config pointing at the
# deployed system/staking/exchange objects. Upstream's run-walrus.sh
# generated this from the deploy file; we need the same. Path is the
# walrus CLI's default search location ($XDG_CONFIG_HOME/walrus/).
mkdir -p /root/.config/walrus
SYSTEM_OBJECT=$(grep '^system_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
STAKING_OBJECT=$(grep '^staking_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
EXCHANGE_OBJECT=$(grep '^exchange_object:' "$WORKING_DIR/deploy" | awk '{print $2}')
cat > /root/.config/walrus/client_config.yaml <<EOF
system_object: ${SYSTEM_OBJECT}
staking_object: ${STAKING_OBJECT}
exchange_objects: [${EXCHANGE_OBJECT}]
EOF

# Step 3: faucet + WAL exchange + balance check, all from the relocated
# config so sui SDK keystore writes land on a real fs.
sui client faucet --url http://sui-localnet:9123/gas
sleep 3
walrus get-wal --amount 500000000000
sui client balance

# Step 4: launch walrus-node.
exec /opt/walrus/bin/walrus-node run --config-path /root/walrus-node.yaml
