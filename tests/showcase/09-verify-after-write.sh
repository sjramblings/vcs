#!/usr/bin/env bash
set -euo pipefail

VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}"
VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
step()  { echo -e "${CYAN}▸ $1${NC}"; }
pass()  { echo -e "${GREEN}✓ $1${NC}"; }
fail()  { echo -e "${RED}✗ $1${NC}"; exit 1; }

API="$VCS_API_URL"
AUTH=(-H "x-api-key: $VCS_API_KEY" -H "Content-Type: application/json")
TIMESTAMP=$(date +%s)
FILENAME="vaw-test-${TIMESTAMP}.md"

echo -e "\n${BOLD}Verify-After-Write: Ingest → Immediate Search${NC}\n"

# ── Step 1: Ingest a document with unique content ────────────────────

UNIQUE_CONTENT="Verify-after-write test document created at ${TIMESTAMP}. Contains unique marker: VAW-${TIMESTAMP}."
ENCODED=$(echo "$UNIQUE_CONTENT" | base64)

step "Ingesting ${FILENAME}..."
INGEST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/resources" \
  "${AUTH[@]}" \
  -d "$(jq -n \
    --arg c "$ENCODED" \
    --arg p "viking://resources/test/" \
    --arg f "$FILENAME" \
    '{content_base64: $c, uri_prefix: $p, filename: $f}')")

INGEST_CODE=$(echo "$INGEST_RESPONSE" | tail -1)
INGEST_BODY=$(echo "$INGEST_RESPONSE" | sed '$d')

if [[ ! "$INGEST_CODE" =~ ^2 ]]; then
  fail "Ingest failed (HTTP $INGEST_CODE): $INGEST_BODY"
fi

STATUS=$(echo "$INGEST_BODY" | jq -r '.processing_status')
pass "Ingested: ${FILENAME} (status: ${STATUS})"

# ── Step 2: Immediately search for the unique content ────────────────

step "Searching immediately (zero delay) for unique marker..."
SEARCH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/search/find" \
  "${AUTH[@]}" \
  -d "$(jq -n \
    --arg q "VAW-${TIMESTAMP} verify after write test" \
    '{query: $q, max_results: 5, min_score: 0.1}')")

SEARCH_CODE=$(echo "$SEARCH_RESPONSE" | tail -1)
SEARCH_BODY=$(echo "$SEARCH_RESPONSE" | sed '$d')

if [[ ! "$SEARCH_CODE" =~ ^2 ]]; then
  fail "Search failed (HTTP $SEARCH_CODE): $SEARCH_BODY"
fi

TARGET_URI="viking://resources/test/${FILENAME}"
FOUND=$(echo "$SEARCH_BODY" | jq -r --arg uri "$TARGET_URI" \
  '[.results // []] | flatten | map(select(.uri == $uri)) | length')

if [[ "$FOUND" -gt 0 ]]; then
  SCORE=$(echo "$SEARCH_BODY" | jq -r --arg uri "$TARGET_URI" \
    '[.results // []] | flatten | map(select(.uri == $uri)) | .[0].score')
  pass "Found ${TARGET_URI} in immediate search (score: ${SCORE})"
else
  RESULT_COUNT=$(echo "$SEARCH_BODY" | jq '[.results // []] | flatten | length')
  fail "NOT FOUND in immediate search. Results returned: ${RESULT_COUNT}. Verify-after-write is not working."
fi

# ── Step 3: Cleanup ──────────────────────────────────────────────────

step "Cleaning up test document..."
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "${API}/fs/rm" \
  "${AUTH[@]}" \
  -d "$(jq -n --arg uri "$TARGET_URI" '{uri: $uri}')")

DELETE_CODE=$(echo "$DELETE_RESPONSE" | tail -1)
if [[ "$DELETE_CODE" =~ ^2 ]]; then
  pass "Cleaned up ${TARGET_URI}"
else
  echo -e "${CYAN}  (cleanup returned HTTP ${DELETE_CODE} — non-fatal)${NC}"
fi

echo ""
pass "Verify-after-write test PASSED. Ingest → immediate search works."
