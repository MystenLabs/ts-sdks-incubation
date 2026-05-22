FROM rust:1.90-bookworm AS builder

ARG SUI_FORK_REPO=https://github.com/MystenLabs/sui.git
ARG SUI_FORK_REV

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates clang cmake git libclang-dev libpq-dev libssl-dev pkg-config protobuf-compiler \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	test -n "$SUI_FORK_REV"; \
	git clone --filter=blob:none "$SUI_FORK_REPO" /src/sui; \
	cd /src/sui; \
	git fetch --depth 1 origin "$SUI_FORK_REV"; \
	git checkout FETCH_HEAD; \
	cargo build --release -p sui-fork; \
	strip /src/sui/target/release/sui-fork

FROM ubuntu:24.04

ARG SUI_CLI_VERSION
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gawk git libpq5 libssl3 \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	test -n "$SUI_CLI_VERSION"; \
	case "$TARGETARCH" in \
		arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \
		amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
	esac; \
	url="https://github.com/MystenLabs/sui/releases/download/${SUI_CLI_VERSION}/sui-${SUI_CLI_VERSION}-${SUI_PLATFORM}.tgz"; \
	curl -fsSL "$url" -o /tmp/sui.tgz; \
	mkdir -p /tmp/sui-unpack; \
	tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \
	find /tmp/sui-unpack -maxdepth 2 -type f -executable -exec mv {} /usr/local/bin/ \; ; \
	rm -rf /tmp/sui.tgz /tmp/sui-unpack; \
	sui --version

COPY --from=builder /src/sui/target/release/sui-fork /usr/local/bin/sui-fork
COPY _shared/signal-forward.sh /usr/local/lib/devstack/signal-forward.sh
COPY sui-fork/entrypoint.sh /usr/local/bin/devstack-sui-fork-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-sui-fork-entrypoint.sh

ENV RUST_LOG=info,sui_fork=info,sui=info

EXPOSE 9000

ENTRYPOINT ["/usr/local/bin/devstack-sui-fork-entrypoint.sh"]
