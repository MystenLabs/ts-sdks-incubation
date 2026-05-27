#!/usr/bin/env bash
# One-shot cleanup of legacy devstack Docker artifacts that label-
# driven prune cannot reach. Run once per host after upgrading to a
# devstack build that stamps `devstack.app/stack/managed` labels on
# every image (see runtime/docker/image.ts::build).
#
# Targets:
#   1. Legacy `devstack-router` network (pre-rewrite, no labels)
#   2. `devstack-build:*` images built before the label fix
#   3. Dangling images (`<none>:<none>`)
#   4. Builder cache
#
# Safe to re-run; nothing here touches resources that prune can find
# on its own.

set -euo pipefail

echo "==> Removing legacy devstack-router network (if present)..."
docker network rm devstack-router 2>/dev/null || true

echo "==> Removing unlabelled devstack-build:* images..."
removed=0
for id in $(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
  | awk '$1 ~ /^devstack-build:/ {print $2}'); do
  lbl=$(docker image inspect "$id" --format '{{index .Config.Labels "devstack.app"}}' 2>/dev/null || true)
  if [ -z "$lbl" ] || [ "$lbl" = "<no value>" ]; then
    if docker image rm -f "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  fi
done
echo "    removed $removed unlabelled devstack-build images"

echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Pruning builder cache..."
docker builder prune -f

echo ""
echo "Done. Run \`docker system df\` to confirm RECLAIMABLE dropped."
