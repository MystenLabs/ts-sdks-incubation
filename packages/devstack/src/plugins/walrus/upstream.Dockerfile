# syntax=docker/dockerfile:1
# Devstack-owned walrus upstream image. Two-stage:
#
#   walrus-build: cargo-build `walrus`, `walrus-node`, and
#                 `walrus-deploy` from source. Source comes from a
#                 BuildKit named context (`--build-context
#                 walrus-src=git#tag`) declared by build.ts.
#   final:        debian:bookworm-slim assembly with the three binaries
#                 + the walrus repo's `/contracts` Move package, layout
#                 matching what the upstream `walrus-service` target
#                 used to produce.
#
# We previously tried a hybrid (binary-fetch for walrus + walrus-node,
# cargo-build for walrus-deploy only) but the walrus team's published
# `walrus-devnet-v*-ubuntu-aarch64.tgz` artifact mismatches its filename:
# it contains x86_64 ELF binaries, not aarch64. On Apple Silicon hosts
# they fail to exec under Rosetta with `failed to open elf at
# /lib64/ld-linux-x86-64.so.2`. Filed in `notes/friction.md` — once
# walrus fixes that, we can re-add a bin-fetch stage to skip the
# walrus + walrus-node compile.
#
# `GIT_REVISION` flows through to the build stage so the
# `walrus_utils::bin_version!` proc-macro can embed a version string
# without shelling `git rev-parse` (the BuildKit named context
# flat-copies the tree without `.git`).

ARG WALRUS_TAG
ARG TARGETARCH
ARG RUST_TOOLCHAIN
ARG GIT_REVISION

# Stage A: compile walrus + walrus-node + walrus-deploy from source.
# Single cargo invocation reuses workspace dependencies — building all
# three binaries is only marginally more expensive than building
# walrus-deploy alone (which already pulls in most of the walrus
# workspace). BuildKit cache mounts make rev-bumps incremental.
FROM rust:${RUST_TOOLCHAIN}-bookworm AS walrus-build
ARG PROFILE=release
ARG GIT_REVISION
# `walrus_utils::bin_version!` checks GIT_REVISION env at compile time.
# Without this the proc-macro panics with E0080 because the BuildKit
# named context is a flat copy without `.git` to shell `git rev-parse`
# against. Setting it as an ENV propagates to cargo's compile process.
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
# BuildKit cache mounts so a version bump only recompiles changed
# crates instead of the full workspace. CARGO_HOME caches registry +
# crates.io/git downloads; /walrus/target caches incremental compile
# output. Ephemeral within the build (BuildKit garbage-collects per
# its own LRU) — safe to share across walrus version bumps. The
# trailing `cp` lifts binaries out of the cache mount so the COPY in
# stage B can reach them (cache mounts don't persist into the final
# image).
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

# Stage B: assemble the runtime image. Same /opt/walrus/{bin,contracts}
# layout the upstream walrus-service target produced, so the testbed
# scripts work unchanged.
#
# `ubuntu:24.04` (not `debian:bookworm-slim`) because the wrapper layer
# bakes in the sui binary from `sui-${SUI_VERSION}-ubuntu-aarch64.tgz`,
# which is linked against glibc 2.38. bookworm ships glibc 2.36 and
# fails with `version 'GLIBC_2.38' not found`. Walrus binaries built
# on rust-1.93-bookworm (glibc 2.36) run fine on ubuntu:24.04 because
# glibc is forward-compatible.
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
