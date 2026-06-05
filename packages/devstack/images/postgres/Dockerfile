# devstack-rewrite vendored postgres image.
#
# Single load-bearing modification: relocate PGDATA off the upstream
# `VOLUME /var/lib/postgresql/data` declaration.
#
# Why: `docker commit` (the mechanism the snapshot engine uses to
# capture a stack's state) excludes paths declared as VOLUME in the
# image. The upstream postgres image declares the data directory as a
# VOLUME, which means docker auto-creates an anonymous volume there
# even when `-v` is not passed. Writes to that volume are NOT in the
# writable layer that `docker commit` captures — so a snapshot of a
# vanilla `postgres:*` container would silently restore as an empty
# database with no rows.
#
# Fix: set `PGDATA` to a path that has NO VOLUME directive in the
# ancestry. `/pgdata` is arbitrary — anywhere outside the inherited
# `/var/lib/postgresql/data` works. Writes land in the container's
# writable layer where `docker commit` (and therefore the snapshot
# engine) captures them.
#
# Distilled doc § Postgres-specific concerns / Invariants:
#   "Vendored image must relocate `PGDATA` off the upstream `VOLUME`
#    path — otherwise snapshot is silently empty."
#
# Default tag tracks `postgres:17-alpine` (one major bump up from v3's
# `16-alpine`). Override via `--build-arg POSTGRES_VERSION=...`.

ARG POSTGRES_VERSION=17-alpine
FROM postgres:${POSTGRES_VERSION}

ENV PGDATA=/var/lib/postgresql/data-devstack
