#!/bin/bash
# Quick verification script for console-mcp
# This mimics what Claude Code does when connecting to a stdio MCP server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🔍 Verifying console-mcp server..."
echo ""

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "$CONSOLE_API_KEY" ]; then
  echo "❌ CONSOLE_API_KEY is not set"
  echo "   Please set it in .env or export it"
  exit 1
fi

echo "✅ CONSOLE_API_KEY is set (starts with: ${CONSOLE_API_KEY:0:8}...)"

if [ -n "$CONSOLE_SERVICE_PRIVATE_KEY" ]; then
  echo "✅ CONSOLE_SERVICE_PRIVATE_KEY is set"
else
  echo "⚠️  CONSOLE_SERVICE_PRIVATE_KEY is not set (some tools will fail)"
fi

echo ""
echo "🚀 Starting console-mcp for up to 8 seconds..."
echo "   (This tests whether the server starts and responds to initialize)"

# Send a basic initialize request and capture the response.
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-script","version":"1.0"}}}'
RESPONSE_FILE="/tmp/console-mcp-verify.out"
LOG_FILE="/tmp/console-mcp-verify.log"
: > "$RESPONSE_FILE"
: > "$LOG_FILE"

# Portable timeout: stock macOS has no GNU `timeout`, so instead of depending
# on it we run the server in the background and stop it ourselves. Works the
# same on macOS, Linux, and CI with no extra tools.
printf '%s\n' "$INIT_REQ" | pnpm exec tsx bin/console-mcp.ts >"$RESPONSE_FILE" 2>"$LOG_FILE" &
SERVER_PID=$!
# Poll for the response for up to 8s, then stop the server.
for _ in $(seq 1 16); do
  grep -q '"serverInfo"' "$RESPONSE_FILE" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

echo ""
if grep -q '"serverInfo":{"name":"console-mcp"' "$RESPONSE_FILE" 2>/dev/null; then
  echo "✅ Server responded to initialize:"
  cat "$RESPONSE_FILE"
else
  echo "❌ Server did not return a valid initialize response."
  echo "📋 Last 30 lines of server log ($LOG_FILE):"
  echo "------------------------------------------------------------"
  tail -30 "$LOG_FILE" 2>/dev/null || echo "(no log file yet)"
  exit 1
fi

echo ""
echo "✅ Verification complete."
echo ""
echo "Next steps:"
echo "  1. Register this server with its ABSOLUTE path (run from the repo root):"
echo "       claude mcp add --scope user walrus-console-mcp -- \"\$(pwd)/bin/console-mcp.sh\""
echo "     (other agents: use the path printed by 'echo \"\$(pwd)/bin/console-mcp.sh\"')"
echo "  2. Restart Claude Code, then type /mcp to see the server and approve it"
echo "  3. Try calling the 'ping_console' or 'list_spaces' tool"
