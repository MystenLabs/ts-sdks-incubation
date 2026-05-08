# syntax=docker/dockerfile:1
# Devstack-owned walrus wrapper image. Composes onto the upstream stage
# (`mysten-devstack/walrus-service:<version>-upstream`) with:
#   - matching sui binary at /root/sui_bin/sui (used by the testbed
#     scripts; we no longer rely on a shared-volume from sui-localnet);
#   - our forked deploy.sh + run.sh at /opt/walrus/scripts/, replacing
#     the upstream's `docker/local-testbed/files/{deploy,run}-walrus.sh`
#     and the 5+ sed patches we used to layer on top of them.
#
# Build context:
#   - the in-tree Dockerfile dir (./) for COPY of deploy.sh + run.sh;
#   - sui-fetch stage downloads the matching sui release tarball.
#
# No `--build-context walrus-src` is needed for the wrapper anymore —
# the upstream stage already baked the walrus source assets it cares
# about (binaries + /contracts).

ARG BASE_IMAGE
ARG SUI_VERSION
ARG TARGETARCH

FROM ubuntu:24.04 AS sui-fetch
ARG SUI_VERSION
ARG TARGETARCH
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eux; \
	case "$TARGETARCH" in \
		arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \
		amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	url="https://github.com/MystenLabs/sui/releases/download/${SUI_VERSION}/sui-${SUI_VERSION}-${SUI_PLATFORM}.tgz"; \
	curl -fsSL "$url" -o /tmp/sui.tgz; \
	mkdir -p /tmp/sui-unpack /sui-bin; \
	tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \
	find /tmp/sui-unpack -maxdepth 2 -type f -executable -name sui -exec mv {} /sui-bin/sui \; ; \
	chmod +x /sui-bin/sui; \
	rm -rf /tmp/sui.tgz /tmp/sui-unpack

FROM ${BASE_IMAGE} AS final
RUN mkdir -p /root/sui_bin /opt/walrus/scripts /var/walrus/storage
COPY --from=sui-fetch /sui-bin/sui /root/sui_bin/sui
RUN chmod +x /root/sui_bin/sui
COPY deploy.sh /opt/walrus/scripts/deploy-walrus.sh
COPY run.sh /opt/walrus/scripts/run-walrus.sh
RUN chmod +x /opt/walrus/scripts/*.sh
