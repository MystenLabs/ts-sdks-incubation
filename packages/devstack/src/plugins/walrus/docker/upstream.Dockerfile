# syntax=docker/dockerfile:1
# devstack-next walrus upstream image. Two-stage:
#
#   walrus-build: cargo-build `walrus`, `walrus-node`, and
#                 `walrus-deploy` from source. Source comes from a
#                 BuildKit named context (`--build-context
#                 walrus-src=git#tag`) declared by the dockerImage
#                 producer's `buildContexts:`.
#   final:        ubuntu:24.04 assembly with the three binaries +
#                 the walrus repo's `/contracts` Move package, layout
#                 matching what the upstream `walrus-service` target
#                 produced.
#
# Single cargo invocation reuses workspace dependencies — building all
# three binaries is only marginally more expensive than building
# walrus-deploy alone (which already pulls in most of the walrus
# workspace). BuildKit cache mounts make rev-bumps incremental.
#
# `GIT_REVISION` flows through to the build stage so the
# `walrus_utils::bin_version!` proc-macro can embed a version string
# without shelling `git rev-parse` (the BuildKit named context flat-
# copies the tree without `.git`).

ARG WALRUS_TAG
ARG TARGETARCH
ARG RUST_TOOLCHAIN
ARG GIT_REVISION

FROM rust:${RUST_TOOLCHAIN}-bookworm AS walrus-build
ARG PROFILE=release
ARG GIT_REVISION
ENV GIT_REVISION=${GIT_REVISION}
WORKDIR /walrus
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		cmake clang pkg-config libssl-dev libpq-dev \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=walrus-src Cargo.toml Cargo.lock ./
COPY --from=walrus-src crates ./crates
COPY --from=walrus-src setup ./setup
COPY --from=walrus-src contracts ./contracts
RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/usr/local/cargo/git \
	--mount=type=cache,target=/walrus/target \
	cargo build --profile $PROFILE \
		--bin walrus \
		--bin walrus-node \
		--bin walrus-deploy \
		--config net.git-fetch-with-cli=true \
	&& cp /walrus/target/release/walrus /walrus/walrus \
	&& cp /walrus/target/release/walrus-node /walrus/walrus-node \
	&& cp /walrus/target/release/walrus-deploy /walrus/walrus-deploy

# `ubuntu:24.04` (not `debian:bookworm-slim`) because the wrapper layer
# bakes in a sui binary linked against glibc 2.38; bookworm ships glibc
# 2.36 and fails with `version 'GLIBC_2.38' not found`. Walrus binaries
# built on rust-1.93-bookworm (glibc 2.36) run fine on ubuntu:24.04
# because glibc is forward-compatible.
FROM ubuntu:24.04 AS final
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git \
	&& rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/walrus/bin
COPY --from=walrus-build /walrus/walrus /opt/walrus/bin/walrus
COPY --from=walrus-build /walrus/walrus-node /opt/walrus/bin/walrus-node
COPY --from=walrus-build /walrus/walrus-deploy /opt/walrus/bin/walrus-deploy
COPY --from=walrus-src contracts /opt/walrus/contracts
RUN chmod +x /opt/walrus/bin/*
