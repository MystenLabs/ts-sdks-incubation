#!/bin/bash
# Robust launcher for console-mcp when used with Claude Code / Desktop
# This script ensures consistent execution environment

set -e

# Go to project root (one level above bin/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Load .env if it exists (so you don't have to put secrets in Claude config)
if [ -f .env ]; then
  # Export variables from .env (ignores comments and empty lines)
  set -a
  source .env
  set +a
fi

# Prefer pnpm exec if pnpm is available (best for this project)
if command -v pnpm &> /dev/null; then
  exec pnpm exec tsx bin/console-mcp.ts
else
  # Fallback to npx tsx
  exec npx tsx bin/console-mcp.ts
fi
