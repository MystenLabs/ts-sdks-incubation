# Sui validator image for the rewrite's local-mode boot. Vendored
# Dockerfile fed to `ContainerRuntime.ensureImage` (content-addressed
# builds — same Dockerfile + build args produce the same image digest).
#
# Multi-arch: the upstream `mysten/sui-tools` image ships amd64 only,
# so on Apple Silicon it runs under Rosetta and `sui start` genesis
# stretches from ~10 s to several minutes. We download the matching
# `ubuntu-aarch64` / `ubuntu-x86_64` release tarball at build time
# instead so the resulting image runs natively on the host.
#
# `ubuntu:24.04` — the Sui release tarballs are linked against
# glibc 2.38+; debian:bookworm (glibc 2.36) fails at runtime with a
# GLIBC_2.38-missing error.

FROM ubuntu:24.04

ARG SUI_VERSION
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl gawk git \
	&& rm -rf /var/lib/apt/lists/*

# Why `gawk` + `git`:
#   - `gawk` — the in-container Move.lock scrub uses `gawk -i inplace`
#     (the `-i` inplace mode is gawk-only; mawk doesn't support it).
#     Without this, the package plugin's `containerScrubShellScript`
#     fails inside `sui move build` with `find: 'gawk': No such
#     file or directory` (host scrub may have already run, but the
#     in-container path still invokes gawk).
#   - `git` — Move's dep resolver invokes `git fetch` against vendored
#     `[dependencies]` blocks (`{ git = "..." }`). Without git on PATH,
#     `sui move build` aborts with a dep-fetch error before reaching
#     the bytecode pass.

# Sui release-tarball fetch. The TARGETARCH branch picks the
# native-architecture asset name and unpacks `sui` (and siblings,
# including `sui-faucet`) into `/usr/local/bin/`.
RUN set -eux; \
	case "$TARGETARCH" in \
		arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \
		amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	url="https://github.com/MystenLabs/sui/releases/download/${SUI_VERSION}/sui-${SUI_VERSION}-${SUI_PLATFORM}.tgz"; \
	curl -fsSL "$url" -o /tmp/sui.tgz; \
	mkdir -p /tmp/sui-unpack; \
	tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \
	find /tmp/sui-unpack -maxdepth 2 -type f -executable -exec mv {} /usr/local/bin/ \; ; \
	rm -rf /tmp/sui.tgz /tmp/sui-unpack; \
	sui --version

COPY _shared/signal-forward.sh /usr/local/lib/devstack/signal-forward.sh
COPY sui/entrypoint.sh /usr/local/bin/devstack-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-entrypoint.sh

ENV RUST_LOG=info,sui=info

# RPC (9000) and faucet (9123). Local-mode boot probes both.
EXPOSE 9000 9123

ENTRYPOINT ["/usr/local/bin/devstack-entrypoint.sh"]
CMD ["start", "--with-faucet=0.0.0.0:9123"]
