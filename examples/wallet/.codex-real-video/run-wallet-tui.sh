#!/usr/bin/env bash
set -euo pipefail

export DEVSTACK_STACK=video
export TERM=xterm-256color

node ../../packages/devstack/dist/cli/main.mjs up --renderer tui &
pid=$!

sleep 20
kill -INT "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
