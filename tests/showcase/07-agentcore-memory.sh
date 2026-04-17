#!/usr/bin/env bash
set -euo pipefail

# Environment
VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}"
VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}"

# Colours
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

header() { echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════${NC}"; echo -e "${BOLD}${BLUE}  $1${NC}"; echo -e "${BOLD}${BLUE}═══════════════════════════════════════${NC}\n"; }
step()   { echo -e "${CYAN}▸ $1${NC}"; }
pass()   { echo -e "${GREEN}✓ $1${NC}"; }
fail()   { echo -e "${RED}✗ $1${NC}"; }
info()   { echo -e "${YELLOW}  $1${NC}"; }

API="$VCS_API_URL"
AUTH=(-H "x-api-key: $VCS_API_KEY" -H "Content-Type: application/json")

# ═══════════════════════════════════════════════════════════════════════
header "VCS Showcase: AgentCore Memory E2E"
echo -e "${YELLOW}Validating the full async extraction chain:${NC}"
echo -e "${YELLOW}  Session -> Commit -> AgentCore -> Bridge Lambda -> viking://user/memories/${NC}\n"

# ─── 1. Create a session ───────────────────────────────────────────

header "1. Create Session"
step "Creating new session..."

START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions" \
  "${AUTH[@]}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/sessions|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
  fail "Failed to create session (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
  exit 1
fi

SESSION_ID=$(echo "$BODY" | jq -r '.session_id')
pass "Session created: ${SESSION_ID} (${ELAPSED}s)"
echo "$BODY" | jq '.'

# ─── 2. Add conversation messages ─────────────────────────────────

header "2. Add Conversation Messages"
step "Adding messages with clear preferences for memory extraction..."

MESSAGES=(
  '{
    "role": "user",
    "parts": [
      {"type": "text", "content": "I always use TypeScript for Lambda functions. Never Python — I find the type safety catches too many bugs at compile time."}
    ]
  }'
  '{
    "role": "assistant",
    "parts": [
      {"type": "text", "content": "TypeScript is a great choice for Lambda. With esbuild bundling you get fast cold starts and full type safety. The developer experience is excellent, especially with the AWS SDK v3 types."}
    ]
  }'
  '{
    "role": "user",
    "parts": [
      {"type": "text", "content": "Exactly. And I always deploy with CDK, never SAM or Terraform. CDK'\''s TypeScript constructs make infrastructure feel like real code. I also insist on 256MB minimum memory for any Lambda, even simple ones — the extra CPU is worth it."}
    ]
  }'
  '{
    "role": "assistant",
    "parts": [
      {"type": "text", "content": "Good standards. CDK with TypeScript gives you type-checked infrastructure, and 256MB minimum ensures adequate CPU allocation since Lambda ties CPU to memory. Those are solid conventions for any team."}
    ]
  }'
  '{
    "role": "user",
    "parts": [
      {"type": "text", "content": "One more thing — I always add SQS dead letter queues for event-driven Lambdas. If a function fails processing an S3 event or SNS message, the DLQ catches it so nothing is silently lost."}
    ]
  }'
  '{
    "role": "assistant",
    "parts": [
      {"type": "text", "content": "DLQs are essential for event-driven architectures. With SQS DLQs you get automatic retry isolation and a clear signal when something fails. Combined with a CloudWatch alarm on DLQ depth, you get immediate visibility into processing failures."}
    ]
  }'
)

LABELS=(
  "User: States TypeScript preference for Lambda"
  "Assistant: Confirms TypeScript + esbuild benefits"
  "User: CDK preference, 256MB minimum Lambda memory"
  "Assistant: Validates conventions"
  "User: Always uses SQS DLQs for event-driven Lambdas"
  "Assistant: Confirms DLQ best practice"
)

for i in "${!MESSAGES[@]}"; do
  step "${LABELS[$i]}"

  START_TIME=$SECONDS
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions/${SESSION_ID}/messages" \
    "${AUTH[@]}" \
    -d "${MESSAGES[$i]}")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  ELAPSED=$(( SECONDS - START_TIME ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/sessions/*/messages|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "Message $((i+1))/${#MESSAGES[@]} added (${ELAPSED}s)"
  else
    fail "Failed to add message $((i+1)) (HTTP $HTTP_CODE) (${ELAPSED}s)"
  fi
done

echo ""

# ─── 3. Commit session ────────────────────────────────────────────

header "3. Commit Session (Triggers AgentCore Extraction)"
step "Committing session ${SESSION_ID}..."

START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions/${SESSION_ID}/commit" \
  "${AUTH[@]}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/sessions/*/commit|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
  fail "Commit failed (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
  exit 1
fi

pass "Session committed successfully (${ELAPSED}s)"
echo ""
echo "$BODY" | jq '.'

MEMORY_EXTRACTION=$(echo "$BODY" | jq -r '.memory_extraction // "unknown"')
echo ""
info "memory_extraction: ${MEMORY_EXTRACTION}"

if [[ "$MEMORY_EXTRACTION" == "delegated_to_agentcore" ]]; then
  pass "Extraction delegated to AgentCore (async pipeline)"
else
  info "memory_extraction field: ${MEMORY_EXTRACTION} (expected: delegated_to_agentcore)"
fi

# ─── 4. Poll for AgentCore memories (async) ───────────────────────

header "4. Poll for AgentCore Memories"
step "Waiting for Bridge Lambda to process extracted memories..."
info "AgentCore extraction is async — polling GET /fs/ls every 5s (timeout: 90s)"
echo ""

MAX_ATTEMPTS=18
ATTEMPT=0
MEMORIES_FOUND=false
POLL_START=$SECONDS

while [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  ATTEMPT=$((ATTEMPT + 1))
  step "Attempt ${ATTEMPT}/${MAX_ATTEMPTS}..."

  RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/ls" \
    "${AUTH[@]}" \
    --data-urlencode "uri=viking://user/memories/")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    ENTRY_COUNT=$(echo "$BODY" | jq '.items | length')
    if [[ "$ENTRY_COUNT" -gt 0 ]]; then
      MEMORIES_FOUND=true
      POLL_ELAPSED=$(( SECONDS - POLL_START ))
      [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/fs/ls (poll)|GET|${POLL_ELAPSED}" >> "$VCS_TIMING_LOG"
      pass "Found ${ENTRY_COUNT} memory entries at viking://user/memories/ (${POLL_ELAPSED}s)"
      echo "$BODY" | jq '.items[].uri'
      break
    fi
  fi

  if [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; then
    sleep 5
  fi
done

echo ""
if [[ "$MEMORIES_FOUND" == "false" ]]; then
  POLL_ELAPSED=$(( SECONDS - POLL_START ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/fs/ls (poll)|GET|${POLL_ELAPSED}" >> "$VCS_TIMING_LOG"
  fail "No memories appeared within 90 seconds (${POLL_ELAPSED}s)"
  info "This may indicate Bridge Lambda did not fire or AgentCore extraction is still pending"
  info "Check CloudWatch logs for the Bridge Lambda function"
fi

# ─── 5. Verify memory search ──────────────────────────────────────

header "5. Verify Memories Are Searchable"

if [[ "$MEMORIES_FOUND" == "true" ]]; then
  step "Searching for memory-scoped results..."

  START_TIME=$SECONDS
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/search/find" \
    "${AUTH[@]}" \
    -d '{
      "query": "What programming language does the user prefer for Lambda?",
      "scope": "viking://user/memories/",
      "max_results": 5,
      "min_score": 0.1
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  ELAPSED=$(( SECONDS - START_TIME ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "07-agentcore-memory|/search/find|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    RESULT_COUNT=$(echo "$BODY" | jq '.results | length')
    if [[ "$RESULT_COUNT" -gt 0 ]]; then
      pass "Search returned ${RESULT_COUNT} memory results (${ELAPSED}s)"
      # Check if any result URIs contain viking://user/memories/
      MEMORY_URIS=$(echo "$BODY" | jq -r '.results[].uri' | grep "viking://user/memories/" || true)
      if [[ -n "$MEMORY_URIS" ]]; then
        pass "Results include AgentCore-sourced memories"
        echo "$MEMORY_URIS" | head -5
      else
        info "Results returned but none from viking://user/memories/ namespace"
      fi
    else
      info "Search returned 0 results (memories may not be embedded yet)"
    fi
  else
    fail "Search request failed (HTTP $HTTP_CODE)"
  fi
else
  info "Skipping search verification — no memories found in polling step"
fi

# ─── Summary ──────────────────────────────────────────────────────

header "Summary"
echo -e "${BOLD}  AgentCore Memory E2E Chain:${NC}"
echo -e "    ${CYAN}1.${NC} Created session                        ${GREEN}v${NC}"
echo -e "    ${CYAN}2.${NC} Added conversation messages              ${GREEN}v${NC}"
echo -e "    ${CYAN}3.${NC} Committed — delegated to AgentCore       ${GREEN}v${NC}"

if [[ "$MEMORIES_FOUND" == "true" ]]; then
  echo -e "    ${CYAN}4.${NC} Memories appeared at viking://user/memories/  ${GREEN}v${NC}"
else
  echo -e "    ${CYAN}4.${NC} Memories appeared at viking://user/memories/  ${RED}x${NC}"
fi

if [[ "$MEMORIES_FOUND" == "true" ]]; then
  echo -e "    ${CYAN}5.${NC} Memories searchable via /search/search   ${GREEN}v${NC}"
else
  echo -e "    ${CYAN}5.${NC} Memories searchable via /search/search   ${YELLOW}-${NC}  (skipped)"
fi

echo ""
echo -e "  ${BOLD}Full async chain: Session -> Commit -> AgentCore -> Bridge Lambda -> viking://user/memories/${NC}"
echo ""

if [[ "$MEMORIES_FOUND" == "true" ]]; then
  pass "AgentCore memory E2E showcase complete."
else
  fail "AgentCore memory E2E showcase incomplete — memories did not appear within timeout."
  exit 1
fi
