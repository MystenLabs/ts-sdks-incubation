#!/bin/sh

set -eu

# shellcheck disable=SC1091
. /usr/local/lib/devstack/signal-forward.sh

# Fail fast with a readable cause when this entrypoint is layered onto a
# sui-tools build that predates `sui-fork` (MystenLabs/sui 892d777c); the
# alternative is a bare exit 127 and a 180s ready-probe timeout.
if ! command -v sui-fork >/dev/null 2>&1; then
	echo 'devstack: `sui-fork` is not in this image. The configured sui-tools ref predates sui-fork landing in mysten/sui-tools (commit 892d777c, v1.80 tags); pick a newer suiToolsRef / DEVSTACK_SUI_TOOLS_REF.' >&2
	exit 127
fi

DATA_DIR=/var/lib/sui-fork
EXPECT_DATA_DIR=0
for ARG in "$@"; do
	if [ "$EXPECT_DATA_DIR" -eq 1 ]; then
		DATA_DIR=$ARG
		EXPECT_DATA_DIR=0
		continue
	fi
	if [ "$ARG" = "--data-dir" ]; then
		EXPECT_DATA_DIR=1
	fi
done

if [ -f "$DATA_DIR/seed_manifest.json" ]; then
	FILTERED_ARGS=$(mktemp)
	SKIP_NEXT=0
	for ARG in "$@"; do
		if [ "$SKIP_NEXT" -eq 1 ]; then
			SKIP_NEXT=0
			continue
		fi
		case "$ARG" in
			--address | --object)
				SKIP_NEXT=1
				continue
				;;
		esac
		printf '%s\n' "$ARG" >>"$FILTERED_ARGS"
	done

	set --
	while IFS= read -r ARG; do
		set -- "$@" "$ARG"
	done <"$FILTERED_ARGS"
	rm -f "$FILTERED_ARGS"
fi

sui-fork "$@" &
SUI_FORK_PID=$!
register_signal_forward "$SUI_FORK_PID"

SUI_FORK_EXIT=0
wait_for_child "$SUI_FORK_PID" || SUI_FORK_EXIT=$?
exit "$SUI_FORK_EXIT"
