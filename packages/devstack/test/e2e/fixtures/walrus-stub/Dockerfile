# Walrus stub image — stand-in for the upstream cargo-built walrus
# image, so e2e tests can exercise the local-cluster boot path without
# the hours-long rust toolchain build the real upstream image needs.
#
# Built once, tagged `walrus-test-stub:latest` (the e2e test sets
# `WALRUS_CARGO_IMAGE_OVERRIDE=walrus-test-stub:latest` so the image
# resolver short-circuits to this tag).
#
# Two behaviors the walrus plugin's local-cluster boot path drives:
#
#   1. `walrus deploy --output-dir /opt/walrus/outputs --committee-size N
#       --shards N --epoch-duration D --sui-rpc-url URL --faucet-url URL
#       --public-hosts CSV --listening-ips CSV` — one-shot.
#      Must emit stdout matching the three regexes in
#      `plugins/walrus/deploy.ts::parseDeployOutput`:
#        - `walrus_package_id: 0x<hex>`
#        - `system_object: 0x<hex>`
#        - `staking_object: 0x<hex>`
#      And emit per-node config files under /opt/walrus/outputs so the
#      storage-node bind-mount (`readonly`) can find them.
#
#   2. Default entrypoint:
#      - storage-node mode binds HTTPS on WALRUS_ROUTER_PORT (9185),
#        answers `/v1/health`, and stays alive.
#      - publisher / aggregator mode binds HTTP on the client-service
#        port, answers `/status`, and stays alive.
#      The plugin's write-ready probe runs `nc -z` and then fetches
#      `/v1/health` with curl inside the container (storage-nodes.ts).
#
# Base image: alpine (busybox shell + bind tools) is the smallest
# image with `nc`, `httpd`, `openssl`, and `sh` for both behaviors.

FROM alpine:3.20

# busybox `httpd` is the listener; curl mirrors the real Walrus image
# so the in-container readiness probe can fetch `/v1/health`. coreutils
# is for `tee`/`mkdir` parity
# with the real walrus binary's deploy output handling. xxd is used
# to mint pseudo-random 32-byte hex object ids on each deploy run so
# the parse regex matches a real-looking address.
RUN apk add --no-cache busybox-extras coreutils curl openssl

COPY walrus /usr/local/bin/walrus
RUN chmod +x /usr/local/bin/walrus

# Default to storage-node mode (long-lived TCP listener on 9185). The
# deploy one-shot path overrides the argv to `walrus deploy ...`; the
# entrypoint dispatches on argv[1].
ENTRYPOINT ["/usr/local/bin/walrus"]
CMD []
