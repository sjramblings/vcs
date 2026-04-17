#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────
# VCS AgentCore Gateway — End-to-End Verification Script
# Verifies OAuth, tools/list (10 tools), tools/call (10 tools),
# and token re-acquisition against the live Gateway.
#
# The Gateway's auto-provisioned Cognito uses client_credentials
# OAuth flow (not USER_PASSWORD_AUTH). This is the standard
# machine-to-machine flow for AgentCore Gateways.
# ────────────────────────────────────────────────────────────

# Configuration (override via env vars)
GATEWAY_URL="${GATEWAY_URL:?GATEWAY_URL is required}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:?COGNITO_CLIENT_ID is required}"
COGNITO_CLIENT_SECRET="${COGNITO_CLIENT_SECRET:?COGNITO_CLIENT_SECRET is required}"
COGNITO_DOMAIN="${COGNITO_DOMAIN:?COGNITO_DOMAIN is required (e.g. mypool.auth.us-east-1.amazoncognito.com)}"
COGNITO_SCOPES="${COGNITO_SCOPES:-}"

# Counters
PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "  PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

snippet() {
  echo "${1:0:200}"
}

acquire_token() {
  # OAuth 2.0 client_credentials flow via Cognito token endpoint
  local token_url="https://${COGNITO_DOMAIN}/oauth2/token"
  local auth_header
  auth_header=$(printf '%s:%s' "$COGNITO_CLIENT_ID" "$COGNITO_CLIENT_SECRET" | base64)

  local post_data="grant_type=client_credentials"
  if [[ -n "$COGNITO_SCOPES" ]]; then
    post_data="${post_data}&scope=${COGNITO_SCOPES}"
  fi

  local result
  result=$(curl -s -X POST "$token_url" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Authorization: Basic ${auth_header}" \
    -d "$post_data" 2>&1)

  echo "$result"
}

call_tool() {
  local tool_name="$1"
  local args_json="$2"
  local payload
  payload=$(cat <<ENDJSON
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"vcs___${tool_name}","arguments":${args_json}},"id":$((RANDOM % 10000))}
ENDJSON
  )

  local http_code body tmpfile
  tmpfile=$(mktemp)

  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X POST "$GATEWAY_URL" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")

  body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  echo "  Tool: vcs___${tool_name} | HTTP: ${http_code}"
  echo "  Response: $(snippet "$body")"

  # Check for success: HTTP 200 and no JSON-RPC error field
  if [[ "$http_code" == "200" ]] && ! echo "$body" | jq -e '.error' >/dev/null 2>&1; then
    pass "vcs___${tool_name}"
  elif [[ "$http_code" == "200" ]]; then
    local has_jsonrpc_error
    has_jsonrpc_error=$(echo "$body" | jq -r '.error.code // empty' 2>/dev/null || true)
    if [[ -z "$has_jsonrpc_error" ]]; then
      local has_result
      has_result=$(echo "$body" | jq -r '.result // empty' 2>/dev/null || true)
      if [[ -n "$has_result" ]]; then
        pass "vcs___${tool_name}"
      else
        fail "vcs___${tool_name} — no result in response"
      fi
    else
      fail "vcs___${tool_name} — JSON-RPC error: code=${has_jsonrpc_error}"
    fi
  else
    fail "vcs___${tool_name} — HTTP ${http_code}"
  fi

  # Save response for callers that need to extract data
  echo "$body" > /tmp/vcs_last_response.json
}

# ═══════════════════════════════════════════════════════════
echo ""
echo "==============================================================="
echo "  VCS AgentCore Gateway — End-to-End Verification"
echo "==============================================================="
echo ""
echo "  Gateway:  $GATEWAY_URL"
echo "  Domain:   $COGNITO_DOMAIN"
echo "  Client:   ${COGNITO_CLIENT_ID:0:8}..."
echo ""

# ─── Step 1: OAuth Token Acquisition (client_credentials) ─
echo "--- Step 1: OAuth Token Acquisition (client_credentials) ---"
echo ""

AUTH_RESULT=$(acquire_token)
ACCESS_TOKEN=$(echo "$AUTH_RESULT" | jq -r '.access_token // empty' 2>/dev/null || true)
EXPIRES_IN=$(echo "$AUTH_RESULT" | jq -r '.expires_in // empty' 2>/dev/null || true)

if [[ -n "$ACCESS_TOKEN" && "$ACCESS_TOKEN" != "null" ]]; then
  pass "Token acquisition — AccessToken obtained (${#ACCESS_TOKEN} chars, expires in ${EXPIRES_IN}s)"
else
  fail "Token acquisition — no access_token received"
  echo "  Auth result: $(snippet "$AUTH_RESULT")"
  echo ""
  echo "FATAL: Cannot continue without access token."
  exit 1
fi

echo ""

# ─── Step 2: tools/list ──────────────────────────────────
echo "--- Step 2: tools/list (verify all 10 VCS tools) ---"
echo ""

LIST_RESULT=$(curl -s -X POST "$GATEWAY_URL" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}')

echo "  Response: $(snippet "$LIST_RESULT")"

TOTAL_TOOL_COUNT=$(echo "$LIST_RESULT" | jq '.result.tools | length' 2>/dev/null || echo "0")
# Gateway adds x_amz_bedrock_agentcore_search internally; count only vcs___ tools
VCS_TOOL_COUNT=$(echo "$LIST_RESULT" | jq '[.result.tools[] | select(.name | startswith("vcs___"))] | length' 2>/dev/null || echo "0")
echo "  Total tools: $TOTAL_TOOL_COUNT (VCS: $VCS_TOOL_COUNT, Gateway internal: $((TOTAL_TOOL_COUNT - VCS_TOOL_COUNT)))"

if [[ "$VCS_TOOL_COUNT" -eq 10 ]]; then
  pass "tools/list returned exactly 10 VCS tools"
else
  fail "tools/list returned $VCS_TOOL_COUNT VCS tools (expected 10)"
fi

# Verify each expected tool name
EXPECTED_TOOLS=("vcs___read" "vcs___ls" "vcs___tree" "vcs___find" "vcs___search" "vcs___ingest" "vcs___create_session" "vcs___add_message" "vcs___used" "vcs___commit_session")
for tool in "${EXPECTED_TOOLS[@]}"; do
  if echo "$LIST_RESULT" | jq -e ".result.tools[] | select(.name == \"$tool\")" >/dev/null 2>&1; then
    pass "Found tool: $tool"
  else
    fail "Missing tool: $tool"
  fi
done

echo ""

# ─── Step 3: tools/call for each of the 10 tools ────────
echo "--- Step 3: tools/call (execute all 10 tools) ---"
echo ""

# 3a. tree (read-only)
echo "[1/10] tree"
call_tool "tree" '{"uri":"viking://resources/","depth":1}'
echo ""

# 3b. ls (read-only)
echo "[2/10] ls"
call_tool "ls" '{"uri":"viking://resources/"}'
echo ""

# 3c. read (L0 abstract, safe)
echo "[3/10] read"
call_tool "read" '{"uri":"viking://resources/","level":0}'
echo ""

# 3d. find (stateless search)
echo "[4/10] find"
call_tool "find" '{"query":"test","max_results":1}'
echo ""

# 3e. create_session (creates session for subsequent tools)
echo "[5/10] create_session"
call_tool "create_session" '{}'
# Gateway wraps tool results in MCP content format: result.content[0].text is JSON string
SESSION_ID=$(cat /tmp/vcs_last_response.json | jq -r '
  (.result.content[0].text // empty) as $text |
  if $text then ($text | fromjson | .session_id // .sessionId // .id // empty) else
    .result.session_id // .result.sessionId // .result.id // empty
  end
' 2>/dev/null || true)
echo "  Session ID: ${SESSION_ID:-NONE}"
echo ""

# 3f. add_message (needs session_id)
echo "[6/10] add_message"
if [[ -n "$SESSION_ID" ]]; then
  call_tool "add_message" "{\"session_id\":\"$SESSION_ID\",\"role\":\"user\",\"content\":\"gateway verification test\"}"
else
  fail "vcs___add_message — skipped, no session_id"
fi
echo ""

# 3g. used (needs session_id)
echo "[7/10] used"
if [[ -n "$SESSION_ID" ]]; then
  call_tool "used" "{\"session_id\":\"$SESSION_ID\",\"uris\":[\"viking://resources/\"]}"
else
  fail "vcs___used — skipped, no session_id"
fi
echo ""

# 3h. search (needs session_id)
echo "[8/10] search"
if [[ -n "$SESSION_ID" ]]; then
  call_tool "search" "{\"query\":\"gateway verification\",\"session_id\":\"$SESSION_ID\",\"max_results\":1}"
else
  fail "vcs___search — skipped, no session_id"
fi
echo ""

# 3i. ingest
echo "[9/10] ingest"
call_tool "ingest" '{"uri_prefix":"viking://resources/gateway-test/","filename":"verify.md","content":"# Gateway Verification\nThis document was ingested via the AgentCore Gateway."}'
echo ""

# 3j. commit_session (must be last session tool)
echo "[10/10] commit_session"
if [[ -n "$SESSION_ID" ]]; then
  call_tool "commit_session" "{\"session_id\":\"$SESSION_ID\"}"
else
  fail "vcs___commit_session — skipped, no session_id"
fi
echo ""

# ─── Step 4: Token Re-acquisition ────────────────────────
echo "--- Step 4: Token Re-acquisition (proves OAuth flow repeatable) ---"
echo ""
echo "  (client_credentials flow does not issue refresh tokens;"
echo "   verifying re-acquisition produces a valid new token)"
echo ""

AUTH_RESULT2=$(acquire_token)
NEW_TOKEN=$(echo "$AUTH_RESULT2" | jq -r '.access_token // empty' 2>/dev/null || true)

if [[ -n "$NEW_TOKEN" && "$NEW_TOKEN" != "null" && "$NEW_TOKEN" != "$ACCESS_TOKEN" ]]; then
  pass "Token re-acquisition — new AccessToken obtained (${#NEW_TOKEN} chars)"

  # Verify new token works with tools/list
  REACQ_LIST=$(curl -s -X POST "$GATEWAY_URL" \
    -H "Authorization: Bearer $NEW_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/list","id":99}')

  REACQ_VCS_COUNT=$(echo "$REACQ_LIST" | jq '[.result.tools[] | select(.name | startswith("vcs___"))] | length' 2>/dev/null || echo "0")
  if [[ "$REACQ_VCS_COUNT" -eq 10 ]]; then
    pass "Re-acquired token works — tools/list returned 10 VCS tools"
  else
    fail "Re-acquired token — tools/list returned $REACQ_VCS_COUNT VCS tools"
  fi
elif [[ -n "$NEW_TOKEN" && "$NEW_TOKEN" != "null" ]]; then
  # Same token returned (within expiry window) — still valid
  pass "Token re-acquisition — token obtained (same token within expiry window)"
  pass "Re-acquired token — same as original, already verified"
else
  fail "Token re-acquisition — no access_token"
  echo "  Result: $(snippet "$AUTH_RESULT2")"
fi

echo ""

# ─── Step 5: Cleanup ─────────────────────────────────────
echo "--- Step 5: Cleanup ---"
echo "  (Leaving gateway-test document as test data)"
rm -f /tmp/vcs_last_response.json
echo ""

# ─── Summary ─────────────────────────────────────────────
echo "==============================================================="
echo "  VERIFICATION SUMMARY"
echo "==============================================================="
echo ""
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "  TOTAL: $TOTAL"
echo ""

if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "  RESULT: ALL TESTS PASSED"
  echo ""
  exit 0
else
  echo "  RESULT: $FAIL_COUNT TESTS FAILED"
  echo ""
  exit 1
fi
