# Seal stub image — stand-in for the upstream cargo-built seal image,
# so e2e tests can exercise the local-keygen boot path without the
# hours-long rust toolchain build the real upstream image needs.
#
# Built once, tagged `seal-test-stub:latest` (the e2e test sets
# `SEAL_CARGO_IMAGE_OVERRIDE=seal-test-stub:latest` so the image
# resolver short-circuits to this tag).
#
# Behaviors the seal plugin's local-keygen boot path drives:
#
#   1. `seal-cli genkey` — one-shot.
#      Must emit stdout matching the two regexes in
#      `plugins/seal/keygen.ts::parseSealKeygenOutput`:
#        - `Master key: 0x<hex>` (32 bytes / 64 hex chars)
#        - `Public key: 0x<hex>` (96 bytes / 192 hex chars —
#          BLS12-381 G2 uncompressed, matching real seal-cli v0.6.6)
#
#   2. Default ENTRYPOINT (key-server mode) — bind TCP on
#      DEFAULT_KEY_SERVER_PORT (2024) and stay alive. The plugin's
#      ready probe is `nc -z 127.0.0.1 2024 || exit 1`
#      (key-server.ts).
#
# Publish/register are SDK-backed now: tests publish the Move package
# under this fixture directory, then call its `key_server` module on
# Sui. The shell script still accepts the old `publish` and
# `register-key-server` subcommands for legacy parser fixtures, but
# current e2e boot does not rely on them.
#
# Base image: alpine (busybox shell + bind tools) is the smallest
# image with `nc -l` and `sh` for all behaviors.

FROM alpine:3.20

# busybox `nc` is the listener; xxd / od for minting pseudo-random
# hex object ids on each invocation so the parse regex matches a
# real-looking address.
RUN apk add --no-cache busybox-extras coreutils

COPY seal-cli /usr/local/bin/seal-cli
RUN chmod +x /usr/local/bin/seal-cli

# Default to key-server mode (long-lived TCP listener on 2024). The
# keygen one-shot path overrides argv to `seal-cli genkey`; legacy
# parser branches still dispatch on argv[1] when called directly.
ENTRYPOINT ["/usr/local/bin/seal-cli"]
CMD []
