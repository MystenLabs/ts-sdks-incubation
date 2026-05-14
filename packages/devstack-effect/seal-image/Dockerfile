# syntax=docker/dockerfile:1
# devstack-effect seal-key-server image. Vendored Dockerfile fed to the
# `dockerImage({build})` runner (content-addressed builds — same
# Dockerfile + build args produce the same tag).
#
# Pulls the published `seal-cli` and `key-server` binaries from the
# seal GitHub release — no Rust compile (the seal release workflow
# already builds and uploads platform binaries). First build is ~30 s
# vs. the ~5–8 min cargo path the old devstack started with.
#
# The move/seal package is NOT staged inside the image: devstack-effect's
# seal primitive fetches the Move source out-of-band via `gitFetch` and
# publishes via the publishMove primitive, so the in-image staging would
# be dead weight here.
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

# Runtime image. debian:bookworm-slim + libpq5 — the `key-server` binary
# links against postgres client libs even when we run it stand-alone.
FROM debian:bookworm-slim AS runtime

EXPOSE 2024 9184

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl libpq5 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=bin-fetch /tmp/seal-cli   /usr/local/bin/seal-cli
COPY --from=bin-fetch /tmp/key-server /usr/local/bin/key-server

# Default to running the key-server. The keygen step overrides the
# entrypoint via `docker run --entrypoint seal-cli ... genkey` to mint
# the BLS12-381 master/public key pair the key-server then loads via
# its `MASTER_KEY` env.
ENTRYPOINT ["/usr/local/bin/key-server"]
