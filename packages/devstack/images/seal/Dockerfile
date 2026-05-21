# syntax=docker/dockerfile:1
# devstack-rewrite seal-key-server image. Vendored Dockerfile fed to
# the `dockerImage({build})` runner via `ContainerRuntime.ensureImage`
# (content-addressed builds — same Dockerfile + build args produce
# the same tag).
#
# Pulls the published `seal-cli` and `key-server` binaries from the
# seal GitHub release — no Rust compile (the seal release workflow
# already builds and uploads platform binaries). First build is ~30 s
# vs. the ~5–8 min cargo path the old devstack started with.
#
# The move/seal package is NOT staged inside the image: the seal
# plugin's local-keygen mode fetches the Move source out-of-band via
# the lifted `source-fetch` sibling and publishes via the SDK, so the
# in-image staging would be dead weight here.
#
# Multi-arch: TARGETARCH (arm64 / amd64) → PLATFORM
# (linux-aarch64 / linux-x86_64) — the seal release renames `seal-cli`
# to `seal-${platform}` for the asset name; we rename it back inside
# the image so the `seal-cli` invocation works unchanged.

FROM ubuntu:24.04 AS bin-fetch
ARG SEAL_VERSION
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	case "$TARGETARCH" in \
		arm64) PLATFORM=linux-aarch64 ;; \
		amd64) PLATFORM=linux-x86_64 ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	base="https://github.com/MystenLabs/seal/releases/download/${SEAL_VERSION}"; \
	curl -fsSL "$base/seal-${PLATFORM}" -o /tmp/seal-cli; \
	curl -fsSL "$base/key-server-${PLATFORM}" -o /tmp/key-server; \
	chmod +x /tmp/seal-cli /tmp/key-server

# Runtime image. debian:bookworm-slim + libpq5 — the `key-server`
# binary links against postgres client libs even when we run it
# stand-alone. `curl` is the ready-probe shim (the plugin's
# `/health` HTTP probe in key-server.ts shells out to curl inside
# the container).
FROM debian:bookworm-slim AS runtime

EXPOSE 2024 9184

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl libpq5 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=bin-fetch /tmp/seal-cli   /usr/local/bin/seal-cli
COPY --from=bin-fetch /tmp/key-server /usr/local/bin/key-server
COPY _shared/signal-forward.sh /usr/local/lib/devstack/signal-forward.sh
COPY seal/entrypoint.sh /usr/local/bin/devstack-seal-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-seal-entrypoint.sh

# Default to running the key-server through a shell wrapper that
# traps docker's SIGTERM and forwards SIGINT to the key-server as a
# non-PID-1 child. See `entrypoint.sh` for the rationale (workaround
# for seal's missing tokio signal handler — same shape as the
# images/sui entrypoint). The keygen step overrides the entrypoint
# via `runOneShot({ entrypoint: 'seal-cli', argv: ['genkey'] })` so
# this wrapper only ever wraps the long-running key-server container.
ENTRYPOINT ["/usr/local/bin/devstack-seal-entrypoint.sh"]
