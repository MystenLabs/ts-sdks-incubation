# Walrus-service image, devstack edition. Layers the local-testbed
# bootstrap scripts (deploy-walrus.sh, run-walrus.sh) onto the upstream
# walrus-service image. The walrus checkout comes from a BuildKit
# named-context (`walrus-src`) — declared as `--build-context
# walrus-src=https://github.com/MystenLabs/walrus.git#<rev>` in
# plugins/walrus/build.ts. Nothing touches the host filesystem; the
# scripts ride inside the final image, so the runtime no longer needs
# host volume mounts to bind them in.

# syntax=docker/dockerfile:1
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS final
COPY --from=walrus-src docker/local-testbed/files/deploy-walrus.sh /opt/walrus/scripts/deploy-walrus.sh
COPY --from=walrus-src docker/local-testbed/files/run-walrus.sh /opt/walrus/scripts/run-walrus.sh
RUN chmod +x /opt/walrus/scripts/*.sh
