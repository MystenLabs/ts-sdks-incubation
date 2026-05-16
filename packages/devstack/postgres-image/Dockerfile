# syntax=docker/dockerfile:1
# devstack postgres image for the sui-indexer-db sidecar.
#
# Why this exists: the upstream `postgres:*` image declares
# `VOLUME /var/lib/postgresql/data`. That directive makes docker create
# an ANONYMOUS volume there even when you don't pass `-v`, and writes to
# that volume are excluded from `docker commit`. The result is that
# `devstack snapshot save` would capture an empty container layer for
# the indexer — every restore would land on a freshly-bootstrapped DB
# with no rows.
#
# Fix: relocate PGDATA to a path WITHOUT the upstream VOLUME directive
# so writes land in the container's writable layer, where `docker commit`
# (and therefore `devstack snapshot save`) sees them. Postgres reads
# PGDATA at startup; the upstream entrypoint creates and chowns the dir.
#
# Cycle teardown via `docker stop` (registered by Docker.run) preserves
# the writable layer for the next `up` to resume — see the INVARIANT
# block in `engine/docker/core.ts` near `removeContainerIfExists`.

ARG POSTGRES_VERSION=16-alpine
FROM postgres:${POSTGRES_VERSION}

# Move the data dir off the upstream VOLUME at /var/lib/postgresql/data
# so the writable layer captures the indexer's schema + row data.
# `/pgdata` is arbitrary — anywhere outside the inherited VOLUME works.
ENV PGDATA=/pgdata
