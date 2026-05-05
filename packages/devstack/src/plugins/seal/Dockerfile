# syntax=docker/dockerfile:1
# Devstack-owned seal image. Pulls the published `seal-cli` and `key-server`
# binaries from the seal GitHub release (no Rust compile) and stages
# the `move/seal` Move package at /opt/seal/move-package for `seal.publish`
# to extract at publish time (via `docker create` + `docker cp`).
#
# The seal release workflow (.github/workflows/release.yml) builds
# `seal-cli` and `key-server` and renames them to `seal-${platform}` and
# `key-server-${platform}` for the release assets. We curl them and
# rename `seal-${platform}` back to `seal-cli` inside the image so the
# plugin's `--entrypoint seal-cli` invocation still works.
#
# The seal source comes from a BuildKit named context (`seal-src`)
# declared by plugins/seal/build.ts as `--build-context
# seal-src=https://github.com/MystenLabs/seal.git#<tag>`, so the Move
# package fetch doesn't touch the host filesystem.
#
# Multi-arch via TARGETARCH — same pattern as the sui-localnet
# Dockerfile.

FROM ubuntu:24.04 AS bin-fetch
ARG SEAL_TAG
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
	base="https://github.com/MystenLabs/seal/releases/download/${SEAL_TAG}"; \
	curl -fsSL "$base/seal-${PLATFORM}" -o /tmp/seal-cli; \
	curl -fsSL "$base/key-server-${PLATFORM}" -o /tmp/key-server; \
	chmod +x /tmp/seal-cli /tmp/key-server

# Runtime image. Same debian:bookworm-slim base + libpq5 the upstream
# from-source build used (key-server's deps were unchanged). ca-certificates
# is needed by the on-chain interactions; curl ships in the base for
# the healthcheck script.
FROM debian:bookworm-slim AS runtime

EXPOSE 2024 9184

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl libpq5 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=bin-fetch /tmp/seal-cli   /usr/local/bin/seal-cli
COPY --from=bin-fetch /tmp/key-server /usr/local/bin/key-server

# Stage the Move package for seal.publish — extracted at publish time
# via `docker create <image>` + `docker cp <id>:/opt/seal/move-package`.
COPY --from=seal-src move/seal /opt/seal/move-package

# Default to running the key-server. Devstack's bootstrap step also invokes
# the image as `docker run --rm <image> seal-cli genkey` — overriding the
# entrypoint with `--entrypoint seal-cli`.
ENTRYPOINT ["/usr/local/bin/key-server"]
