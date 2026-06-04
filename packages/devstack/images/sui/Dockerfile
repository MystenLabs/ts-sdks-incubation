# Sui validator image for the rewrite's local-mode boot. Vendored
# Dockerfile fed to `ContainerRuntime.ensureImage` (content-addressed
# builds — same Dockerfile + build args produce the same image digest).
#
# Base: `mysten/sui-tools` pinned per-arch (the tag is NOT a multi-arch
# manifest list, so the caller appends `-arm64` on Apple Silicon — see
# `suiCliImageBuildContext` in src/plugins/sui/move/index.ts). The image
# bundles `sui`/`sui-faucet`/`sui-tool`/`git`/`libpq`.

ARG SUI_TOOLS_IMAGE
FROM ${SUI_TOOLS_IMAGE}

# `gawk` — the in-container Move.lock scrub uses `gawk -i inplace` (the
# `-i` inplace mode is gawk-only; mawk doesn't support it). sui-tools
# ships `git` (Move's dep resolver runs `git fetch`) but not gawk.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends gawk \
	&& rm -rf /var/lib/apt/lists/*

COPY sui/entrypoint.sh /usr/local/bin/devstack-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-entrypoint.sh

ENV RUST_LOG=info,sui=info

# Stop with SIGINT, not SIGTERM. The entrypoint `exec sui …` makes sui
# PID 1, and `sui start --with-faucet` only registers a SIGINT (ctrl-c)
# handler — `start_faucet`'s `axum::serve(...).await` shadows sui's
# `tokio::signal::ctrl_c()` for SIGTERM, so SIGTERM is ignored. Without
# this, `docker stop` (default SIGTERM) waits the full grace then escalates
# to SIGKILL → exit 137; `recreate: 'on-failure'` then RECREATES the
# validator on the next boot, destroying the persisted RocksDB chain state
# that warm restart/resume relies on. SIGINT drains RocksDB and exits 0 in
# <1s (verified, plain + external-indexer configs).
STOPSIGNAL SIGINT

# RPC (9000), faucet (9123), GraphQL consistent-store helper (9124),
# and GraphQL HTTP (9125). Local-mode boot probes the public surfaces.
EXPOSE 9000 9123 9124 9125

# GraphQL is gated at the env-wiring layer (NOT in this static CMD, which
# must stay graphql-less so the indexer:false path works): the entrypoint
# appends `--with-graphql` only when `DEVSTACK_SUI_INDEXER_URL` is set. The
# sui plugin sets that var by DEFAULT (pointing at the postgres sidecar it
# owns), so the default boot is full RPC + faucet + GraphQL.
ENTRYPOINT ["/usr/local/bin/devstack-entrypoint.sh"]
CMD ["start", "--with-faucet=0.0.0.0:9123"]
