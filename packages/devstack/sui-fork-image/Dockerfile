# devstack sui-fork image. Vendored Dockerfile fed to the
# `dockerImage` runner (content-addressed builds — same Dockerfile +
# build args produce the same tag).
#
# Unlike `../sui-image/Dockerfile` (which downloads a prebuilt release
# tarball for `sui start`), this image builds the `sui-fork` binary
# from source at a pinned `MystenLabs/sui` commit because:
#   - No published `sui-fork` release tarballs exist yet.
#   - No upstream Docker image is published.
# Build is multi-stage so the runtime image stays small (no rust
# toolchain), and uses `--platform=$BUILDPLATFORM` on the builder so
# cross-compiling for arm64 hosts from amd64 CI builders works.
#
# OD4 decision (sui→sui-fork alias): we symlink `sui` to `sui-fork` in
# the runtime image so `SuiBuildContainer` (which `docker exec`s `sui
# move build` inside the container) continues to work without
# per-runtime branching. `sui-fork` accepts and ignores any `sui`
# subcommand-ish flags it doesn't recognize at the top level — but in
# practice `SuiBuildContainer` shells out to `sui` for `move build` /
# `move summary` which are pure compile operations that don't need the
# fork's networking. Today, the `sui` and `sui-fork` CLIs share the
# same workspace `Cargo.toml` so the `sui` binary is also available;
# we install both and prefer the `sui` binary for `move build` while
# the entrypoint dispatches `sui-fork start` for the long-running
# process.

ARG BUILDPLATFORM
ARG TARGETARCH

# -----------------------------------------------------------------------------
# builder — compile sui-fork (and sui, for in-container move builds)
# -----------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM rust:1.85-bookworm AS builder

# Pinned upstream commit. Bump in lockstep with sui-fork crate API
# changes. The plan calls out that `sui-fork` is a young crate so the
# pin is expected to roll forward frequently in the first months.
ARG SUI_REV
ENV SUI_REV=${SUI_REV}

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl git build-essential \
		clang cmake libpq-dev libssl-dev libsasl2-dev pkg-config \
		protobuf-compiler libprotobuf-dev \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init . \
	&& git remote add origin https://github.com/MystenLabs/sui.git \
	&& git fetch --depth 1 origin "${SUI_REV}" \
	&& git checkout FETCH_HEAD

# Build `sui-fork` first (the primary binary this image ships). Also
# build `sui` so the in-container `move build` path (see
# `engine/sui-build-container.ts`) works without re-downloading a
# release tarball. Both binaries flow from the same workspace so the
# extra `-p sui` adds ~5 minutes on first build and ~30 seconds on a
# warm rust cache.
RUN cargo build --release -p sui-fork -p sui \
	&& mkdir -p /out \
	&& cp target/release/sui-fork /out/sui-fork \
	&& cp target/release/sui /out/sui

# -----------------------------------------------------------------------------
# runtime — minimal image carrying the built binaries + entrypoint
# -----------------------------------------------------------------------------

FROM ubuntu:24.04 AS runtime

ARG SUI_REV
LABEL devstack.sui-fork.rev=${SUI_REV}

# Runtime deps:
#   - `ca-certificates` — sui-fork dials upstream GraphQL over HTTPS
#     for warming + miss-fetches; without CAs every fetch fails.
#   - `gawk` — required by `engine/sui-cli.ts:containerBuildCmd`'s
#     Move.lock scrub (uses `gawk -i inplace`, a gawk-only extension).
#     Mirrors the corresponding apt line in `../sui-image/Dockerfile`.
#   - `curl` — useful for in-container debugging + future ready-probe
#     side-channels.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl gawk libssl3 libpq5 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/sui-fork /usr/local/bin/sui-fork
COPY --from=builder /out/sui /usr/local/bin/sui

# OD4: alias `/usr/local/bin/sui-fork` <- `sui-fork-real` so we can
# both keep the original binary AND ship a `sui` alias the build
# container expects. We do NOT overwrite `sui` (which is a full
# upstream binary used for `move build`/`move summary`); instead the
# entrypoint dispatches `sui-fork start` directly. The plan says
# "alias sui→sui-fork"; we keep both side-by-side because
# SuiBuildContainer's `move build` / `move summary` need real
# upstream sui semantics that `sui-fork` doesn't reimplement.
RUN ln -sf /usr/local/bin/sui /usr/local/bin/sui-cli \
	&& sui-fork --version \
	&& sui --version

COPY entrypoint.sh /usr/local/bin/devstack-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-entrypoint.sh

ENV RUST_LOG=info,sui=info,sui_fork=info

EXPOSE 9000

# Default to `start` — the entrypoint script translates devstack-
# friendly env vars (`SUI_FORK_NETWORK`, `SUI_FORK_CHECKPOINT`,
# `SUI_FORK_DATA_DIR`, `SUI_FORK_SEED_ADDRS`, `SUI_FORK_SEED_OBJS`) into
# the matching `sui-fork start --flag ...` invocation. Any args passed
# to `docker run` ARE passed through to the entrypoint AFTER the env-
# var-derived flags, so callers can override per-invocation.
ENTRYPOINT ["/usr/local/bin/devstack-entrypoint.sh"]
CMD ["start"]
