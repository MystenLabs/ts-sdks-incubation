# syntax=docker/dockerfile:1
# Devstack-owned seal image. Builds key-server + seal-cli, plus stages the
# `move/seal` Move package at /opt/seal/move-package for `seal.publish`
# to extract at publish time (via `docker create` + `docker cp`).
#
# The seal source comes from a BuildKit named context (`seal-src`)
# declared by plugins/seal/build.ts as `--build-context
# seal-src=https://github.com/MystenLabs/seal.git#<rev>`, so nothing
# touches the host filesystem during build.
#
# We don't reuse upstream's official Dockerfile because (1) it only builds
# key-server, and we need seal-cli for `genkey` during devstack bootstrap, and
# (2) we want a multi-arch build, not the upstream amd64-only mainnet image.
#
# Rust toolchain matches upstream rust-toolchain.toml (1.90).
FROM rust:1.90-bullseye AS builder

ARG PROFILE=release

WORKDIR /work

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		cmake clang pkg-config libssl-dev libpq-dev \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=seal-src crates ./crates
COPY --from=seal-src Cargo.toml Cargo.lock ./

ARG GIT_REVISION
ENV GIT_REVISION=$GIT_REVISION

RUN cargo build \
		--bin key-server --bin seal-cli \
		--profile $PROFILE \
		--config net.git-fetch-with-cli=true

FROM debian:bullseye-slim AS runtime

EXPOSE 2024 9184

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl libpq5 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /work/target/release/key-server /usr/local/bin/key-server
COPY --from=builder /work/target/release/seal-cli   /usr/local/bin/seal-cli

# Stage the Move package for seal.publish — extracted at publish time
# via `docker create <image>` + `docker cp <id>:/opt/seal/move-package`.
COPY --from=seal-src move/seal /opt/seal/move-package

# Default to running the key-server. Devstack's bootstrap step also invokes
# the image as `docker run --rm <image> seal-cli genkey` — overriding the
# entrypoint with `--entrypoint seal-cli`.
ENTRYPOINT ["/usr/local/bin/key-server"]
