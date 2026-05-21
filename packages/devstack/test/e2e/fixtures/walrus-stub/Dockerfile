# Walrus stub image — stand-in for the upstream cargo-built walrus
# image, so e2e tests can exercise the local-cluster boot path without
# the hours-long rust toolchain build the real upstream image needs.
#
# Built once, tagged `walrus-test-stub:latest` (the e2e test sets
# `WALRUS_CARGO_IMAGE_OVERRIDE=walrus-test-stub:latest` so the lifted-
# sibling resolver short-circuits to this image instead of failing
# with the documented "cargo build not implemented" seam error).
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
#   2. Default entrypoint (storage-node mode) — bind TCP on
#      WALRUS_ROUTER_PORT (9185) and stay alive. The plugin's ready
#      probe is `nc -z 127.0.0.1 9185 || exit 1` (storage-nodes.ts).
#
# Base image: alpine (busybox shell + bind tools) is the smallest
# image with `nc -l` and `sh` for both behaviors.

FROM alpine:3.20

# busybox `nc` is the listener; coreutils for `tee`/`mkdir` parity
# with the real walrus binary's deploy output handling. xxd is used
# to mint pseudo-random 32-byte hex object ids on each deploy run so
# the parse regex matches a real-looking address.
RUN apk add --no-cache busybox-extras coreutils

COPY walrus /usr/local/bin/walrus
RUN chmod +x /usr/local/bin/walrus

# Default to storage-node mode (long-lived TCP listener on 9185). The
# deploy one-shot path overrides the argv to `walrus deploy ...`; the
# entrypoint dispatches on argv[1].
ENTRYPOINT ["/usr/local/bin/walrus"]
CMD []
