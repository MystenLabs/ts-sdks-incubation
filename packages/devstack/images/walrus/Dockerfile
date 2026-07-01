# Walrus image for local-cluster mode. Vendored Dockerfile fed to
# `ContainerRuntime.ensureImage` (content-addressed builds: same
# Dockerfile + build args produce the same image digest).
#
# The image packages upstream release binaries only. TARGETARCH selects
# the matching Walrus and Sui release tarballs, and the build verifies
# the selected Walrus asset is native for that target before accepting it.
#
# Two binary sets baked in:
#
#   1. walrus / walrus-deploy / walrus-node / walrus-upload-relay — from the walrus release
#      tarball at WALRUS_VERSION.
#
#   2. sui binary — from the sui release tarball at SUI_VERSION. The
#      deploy/run scripts need a matching `sui` on PATH.
#
# Also vendored:
#
#   - /opt/walrus/scripts/deploy-walrus.sh — testbed deploy script. Runs
#     once per stack via `runOneShot`. Emits per-node `dryrun-node-<i>.{yaml,
#     keystore}` and a deploy summary file with system_object /
#     staking_object / exchange_object ids.
#
#   - /opt/walrus/scripts/run-walrus.sh — long-running node entrypoint.
#     Relocates per-node configs out of the read-only deploy mount,
#     swaps SUI for WAL, and execs `walrus-node run`.
#
#   - /opt/walrus/scripts/run-walrus-client-service.sh — long-running
#     release CLI entrypoint for `walrus aggregator`, `walrus publisher`,
#     and `walrus-upload-relay`.
#     Relocates deploy-generated client config and execs the selected
#     service command.
#
# `ubuntu:24.04` because the walrus + sui binaries link against
# glibc 2.38+; debian:bookworm (glibc 2.36) fails at runtime.

FROM ubuntu:24.04

ARG WALRUS_VERSION
ARG SUI_VERSION
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl file gawk git jq netcat-openbsd \
	&& rm -rf /var/lib/apt/lists/*

# Walrus release-tarball fetch. Asset naming:
#   walrus-<VERSION>-{ubuntu,macos}-{aarch64,x86_64}.tgz
# We're inside ubuntu so platform is always `ubuntu-{arch}`.
RUN set -eux; \
	case "$TARGETARCH" in \
		arm64) WALRUS_PLATFORM=ubuntu-aarch64; EXPECTED_FILE_ARCH='ARM aarch64' ;; \
		amd64) WALRUS_PLATFORM=ubuntu-x86_64; EXPECTED_FILE_ARCH='x86-64' ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	url="https://github.com/MystenLabs/walrus/releases/download/${WALRUS_VERSION}/walrus-${WALRUS_VERSION}-${WALRUS_PLATFORM}.tgz"; \
	curl -fsSL "$url" -o /tmp/walrus.tgz; \
	mkdir -p /opt/walrus/bin /tmp/walrus-unpack; \
	tar -xzf /tmp/walrus.tgz -C /tmp/walrus-unpack; \
	find /tmp/walrus-unpack -maxdepth 2 -type f -executable -exec mv {} /opt/walrus/bin/ \; ; \
	chmod +x /opt/walrus/bin/*; \
	for bin in walrus walrus-node walrus-deploy walrus-upload-relay; do \
		test -x "/opt/walrus/bin/${bin}" || { \
			echo "walrus release ${WALRUS_VERSION} missing required binary ${bin}" >&2; \
			ls -la /opt/walrus/bin >&2; \
			exit 1; \
		}; \
		file "/opt/walrus/bin/${bin}" | grep -q "$EXPECTED_FILE_ARCH" || { \
			echo "walrus release ${WALRUS_VERSION} asset ${WALRUS_PLATFORM} is not native for TARGETARCH=${TARGETARCH}: ${bin}" >&2; \
			file "/opt/walrus/bin/${bin}" >&2; \
			exit 1; \
		}; \
	done; \
	rm -rf /tmp/walrus.tgz /tmp/walrus-unpack; \
	/opt/walrus/bin/walrus --version; \
	/opt/walrus/bin/walrus aggregator --help >/dev/null; \
	/opt/walrus/bin/walrus publisher --help >/dev/null; \
	/opt/walrus/bin/walrus-upload-relay --help >/dev/null; \
	/opt/walrus/bin/walrus-node --help >/dev/null; \
	/opt/walrus/bin/walrus-deploy --help >/dev/null

# Sui release-tarball fetch (same logic as ../sui/Dockerfile).
RUN set -eux; \
	case "$TARGETARCH" in \
		arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \
		amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	url="https://github.com/MystenLabs/sui/releases/download/${SUI_VERSION}/sui-${SUI_VERSION}-${SUI_PLATFORM}.tgz"; \
	curl -fsSL "$url" -o /tmp/sui.tgz; \
	mkdir -p /root/sui_bin /tmp/sui-unpack; \
	tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \
	find /tmp/sui-unpack -maxdepth 2 -type f -executable -name sui -exec mv {} /root/sui_bin/sui \; ; \
	chmod +x /root/sui_bin/sui; \
	rm -rf /tmp/sui.tgz /tmp/sui-unpack; \
	/root/sui_bin/sui --version

# Walrus Move contracts (release tarball doesn't include them; the
# walrus-deploy CLI needs `--contract-dir /opt/walrus/contracts` to
# locate the wal/walrus Move packages). Pinned to WALRUS_VERSION so
# the contract source stays in lockstep with the binary release.
RUN set -eux; \
	git clone --depth 1 --branch "${WALRUS_VERSION}" \
		https://github.com/MystenLabs/walrus.git /tmp/walrus-src; \
	mkdir -p /opt/walrus/contracts; \
	cp -r /tmp/walrus-src/contracts/* /opt/walrus/contracts/; \
	rm -rf /tmp/walrus-src

# Surface both binary sets on PATH so scripts shell out cleanly.
RUN ln -sf /opt/walrus/bin/walrus /usr/local/bin/walrus \
	&& ln -sf /opt/walrus/bin/walrus-node /usr/local/bin/walrus-node \
	&& ln -sf /opt/walrus/bin/walrus-deploy /usr/local/bin/walrus-deploy \
	&& ln -sf /opt/walrus/bin/walrus-upload-relay /usr/local/bin/walrus-upload-relay \
	&& ln -sf /root/sui_bin/sui /usr/local/bin/sui

RUN mkdir -p /opt/walrus/scripts /opt/walrus/outputs /var/walrus/storage

COPY deploy-walrus.sh /opt/walrus/scripts/deploy-walrus.sh
COPY run-walrus.sh /opt/walrus/scripts/run-walrus.sh
COPY run-walrus-client-service.sh /opt/walrus/scripts/run-walrus-client-service.sh
RUN chmod +x /opt/walrus/scripts/*.sh

ENV RUST_LOG=info,walrus=info

STOPSIGNAL SIGINT

# Storage-node REST port. Distilled-doc invariant 9. Client services bind
# their release CLI default unless overridden by env.
EXPOSE 9185
EXPOSE 31415
EXPOSE 3000

# Default to storage-node entrypoint. The deploy one-shot overrides
# via `runOneShot` argv: argv[0] == 'deploy' runs `deploy-walrus.sh`.
# `aggregator`, `publisher`, and `upload-relay` run release-provided client services;
# any other command falls back to the storage-node entrypoint.
ENTRYPOINT ["/bin/bash", "-c", "case \"${1:-}\" in deploy) shift; exec /opt/walrus/scripts/deploy-walrus.sh \"$@\" ;; aggregator|publisher|upload-relay) mode=\"$1\"; shift; exec /opt/walrus/scripts/run-walrus-client-service.sh \"$mode\" \"$@\" ;; *) exec /opt/walrus/scripts/run-walrus.sh ;; esac", "--"]
CMD []
