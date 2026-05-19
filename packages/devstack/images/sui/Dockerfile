# devstack-next sui-localnet image. Vendored Dockerfile fed to the
# `dockerImage` runner (content-addressed builds — same Dockerfile +
# build args produce the same tag).
#
# Multi-arch: downloads the matching Sui release tarball at build time
# (`ubuntu-aarch64` on arm64 hosts, `ubuntu-x86_64` on amd64). We don't
# use `mysten/sui-tools` because it only ships amd64; Apple Silicon
# would emulate via Rosetta and `sui start` genesis would take minutes
# instead of seconds.
#
# ubuntu:24.04 — the Sui release tarballs are linked against glibc
# 2.38+, so debian:bookworm (glibc 2.36) fails with a GLIBC_2.38-missing
# error.
FROM ubuntu:24.04

ARG SUI_VERSION
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl git gawk \
	&& rm -rf /var/lib/apt/lists/*
# gawk is required by the in-container Move.lock scrub
# (`engine/sui-cli.ts:containerBuildCmd` uses `gawk -i inplace`, a gawk-
# only extension that Ubuntu's default mawk doesn't support). Without
# this, builds that miss the publishMove state-store cache fail with
# `awk: not an option: -i`. The cache hit path masked the problem on
# warm-start, but a fresh apply or snapshot-restore-then-publish always
# tripped it.

# Sui release-tarball fetch. NOTE: a near-identical block lives in
# `../walrus/wrapper.Dockerfile` (sui-fetch stage). The two are
# intentionally NOT extracted to a shared base — destinations differ
# (`/usr/local/bin/` here vs `/sui-bin/sui` there) and `dockerImage`'s
# content-addressed hash walks the whole build context, so widening
# context to a sibling `_base/` dir would couple unrelated images'
# cache keys. Version bumps happen via `DEFAULT_SUI_VERSION` in
# `src/services/sui.ts` + `src/services/walrus/internal.ts`, NOT here.
# If you edit the curl/tar logic below, mirror the change in
# `../walrus/wrapper.Dockerfile`.
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

COPY entrypoint.sh /usr/local/bin/devstack-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-entrypoint.sh

ENV RUST_LOG=info,sui=info

EXPOSE 9000 9123

ENTRYPOINT ["/usr/local/bin/devstack-entrypoint.sh"]
CMD ["start", "--with-faucet=0.0.0.0:9123"]
