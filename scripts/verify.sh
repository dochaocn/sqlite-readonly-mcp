#!/usr/bin/env bash
set -euo pipefail
: "${SQLITE_PATH:?}"
: "${BEARER_TOKEN:?}"
: "${MCP_URL:=http://127.0.0.1:3333/mcp}"

curl -sS -f -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
  "$MCP_URL" | grep -q 200

echo "initialize ok"
