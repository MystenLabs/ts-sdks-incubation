# syntax=docker/dockerfile:1
# devstack-next walrus wrapper image. Composes onto the upstream image
# (BASE_IMAGE = walrus.image.upstream's content-addressed tag) with:
#   - matching sui binary at /root/sui_bin/sui (used by run.sh / deploy.sh
#     scripts; we don't rely on a shared volume from sui-localnet);
#   - forked deploy.sh + run.sh at /opt/walrus/scripts/, owned in-tree
#     so we don't depend on the walrus repo's `docker/local-testbed/`
#     layout (the walrus team is migrating their canonical local-testbed
#     to procman).
#
# `BASE_IMAGE` is set by the dockerImage producer to `walrus.image
# .upstream`'s tag; its content-addressed identity propagates through
# this image's input hash so an upstream rebuild flips this tag too.
ARG BASE_IMAGE
ARG SUI_VERSION
ARG TARGETARCH

# Sui release-tarball fetch (builder stage). NOTE: a near-identical
# block lives in `../sui/Dockerfile`. The two are intentionally
# NOT extracted to a shared base — destinations differ (`/sui-bin/sui`
# here vs `/usr/local/bin/` there) and `dockerImage`'s content-addressed
# hash walks the whole build context, so widening context to a sibling
# `_base/` dir would couple unrelated images' cache keys. Version bumps
# happen via `DEFAULT_SUI_VERSION` in `src/services/sui.ts` +
# `src/services/walrus/internal.ts`, NOT here. If you edit the curl/tar
# logic below, mirror the change in `../sui/Dockerfile`.
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
