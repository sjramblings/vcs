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
header "VCS Showcase: Namespace Browser"
echo -e "${YELLOW}Exploring the viking:// filesystem — listing, reading, moving.${NC}"
echo -e "${YELLOW}Prerequisite: run 01-ingestion-pipeline.sh first.${NC}\n"

# ─── 1. List root namespace ────────────────────────────────────────

header "1. Root Namespace (viking://resources/)"
step "Listing viking://resources/ ..."

START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/ls" \
  "${AUTH[@]}" \
  --data-urlencode "uri=viking://resources/")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/ls|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "$BODY" | jq '.'
  pass "Root namespace listed (${ELAPSED}s)"
else
  fail "Failed to list root namespace (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
fi

# ─── 2. Tree for viking://resources/showcase/ ───────────────────────────────

header "2. Directory Tree (viking://resources/showcase/)"
step "Fetching recursive tree..."

START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/tree" \
  "${AUTH[@]}" \
  --data-urlencode "uri=viking://resources/showcase/" \
  --data-urlencode "depth=5")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/tree|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "$BODY" | jq '.'
  pass "Tree retrieved (${ELAPSED}s)"
else
  fail "Failed to retrieve tree (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
fi

# ─── 3. Side-by-side L0 / L1 / L2 comparison ─────────────────────

DOC_URI="viking://resources/showcase/docs/cloud-security-basics.md"

header "3. Multi-Level Read: ${DOC_URI}"

for LEVEL in 0 1 2; do
  case $LEVEL in
    0) LABEL="L0 — Abstract (~100 tokens)" ;;
    1) LABEL="L1 — Overview (~2K tokens)" ;;
    2) LABEL="L2 — Full Content" ;;
  esac

  step "Reading at Level ${LEVEL}: ${LABEL}"

  START_TIME=$SECONDS
  RESPONSE=$(curl -s -G "${API}/fs/read" \
    "${AUTH[@]}" \
    --data-urlencode "uri=$DOC_URI" \
    --data-urlencode "level=$LEVEL")
  ELAPSED=$(( SECONDS - START_TIME ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/read|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

  TOKENS=$(echo "$RESPONSE" | jq '.tokens // 0')

  if [[ "$LEVEL" -eq 0 ]]; then
    CONTENT=$(echo "$RESPONSE" | jq -r '.content // "empty"')
    echo -e "${BOLD}  Level 0 — ${TOKENS} tokens${NC}"
    echo "  $CONTENT"
  elif [[ "$LEVEL" -eq 1 ]]; then
    # L1 is a JSON array of sections — format nicely
    SECTION_COUNT=$(echo "$RESPONSE" | jq -r '.content' | jq 'length' 2>/dev/null || echo "?")
    echo -e "${BOLD}  Level 1 — ${TOKENS} tokens (${SECTION_COUNT} sections)${NC}"
    echo "$RESPONSE" | jq -r '.content' | jq -r '.[] | "  • \(.title): \(.summary[0:100])..."' 2>/dev/null || echo "  (raw content)"
  else
    # L2 — content is in S3, API returns empty string
    S3_KEY=$(echo "$RESPONSE" | jq -r '.s3_key // "unknown"')
    echo -e "${BOLD}  Level 2 — full content (stored in S3)${NC}"
    echo "  S3 key: ${S3_KEY}"
  fi
  echo ""
done

pass "Multi-level comparison complete"

# ─── 4. Create directory and move document ─────────────────────────

header "4. Filesystem Operations: mkdir + mv"

step "Creating directory viking://resources/showcase/archive/ ..."
START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/fs/mkdir" \
  "${AUTH[@]}" \
  -d '{"uri": "viking://resources/showcase/archive/"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/mkdir|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  pass "Directory created (${ELAPSED}s)"
  echo "$BODY" | jq '.'
else
  info "Directory may already exist (HTTP $HTTP_CODE) (${ELAPSED}s)"
fi

echo ""
step "Moving cloud-security-basics.md to archive/ ..."

START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/fs/mv" \
  "${AUTH[@]}" \
  -d '{
    "from_uri": "viking://resources/showcase/docs/cloud-security-basics.md",
    "to_uri": "viking://resources/showcase/archive/cloud-security-basics.md"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/mv|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  pass "Document moved successfully (${ELAPSED}s)"
  echo "$BODY" | jq '.'
else
  fail "Move failed (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
fi

echo ""
step "Verifying — listing viking://resources/showcase/archive/ ..."
START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/ls" \
  "${AUTH[@]}" \
  --data-urlencode "uri=viking://resources/showcase/archive/")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/ls|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "$BODY" | jq '.'
  pass "Archive listing retrieved (${ELAPSED}s)"
else
  fail "Failed to list archive (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
fi

echo ""
step "Verifying — listing viking://resources/showcase/docs/ (should be missing the moved file) ..."
START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/ls" \
  "${AUTH[@]}" \
  --data-urlencode "uri=viking://resources/showcase/docs/")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/ls|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "$BODY" | jq '.'
  pass "Docs listing retrieved (${ELAPSED}s)"
else
  fail "Failed to list docs (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY"
fi

# ─── 5. Move it back (cleanup) ────────────────────────────────────

echo ""
step "Moving document back to docs/ (cleanup) ..."
START_TIME=$SECONDS
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/fs/mv" \
  "${AUTH[@]}" \
  -d '{
    "from_uri": "viking://resources/showcase/archive/cloud-security-basics.md",
    "to_uri": "viking://resources/showcase/docs/cloud-security-basics.md"
  }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
ELAPSED=$(( SECONDS - START_TIME ))
[[ -n "${VCS_TIMING_LOG:-}" ]] && echo "03-namespace-browser|/fs/mv|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "$BODY" | jq '.'
  pass "Cleanup complete — document restored (${ELAPSED}s)"
else
  fail "Failed to restore document (HTTP $HTTP_CODE) (${ELAPSED}s)"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
fi

# ─── Visual summary ───────────────────────────────────────────────

header "Agent Scanning Pattern"
echo -e "${BOLD}  How an agent navigates the namespace:${NC}"
echo ""
echo -e "  ${CYAN}Step 1:${NC} Scan L0 abstracts (~100 tokens each)  ${GREEN}→ cheap${NC}"
echo -e "  ${CYAN}Step 2:${NC} Decide which docs are relevant        ${GREEN}→ fast${NC}"
echo -e "  ${CYAN}Step 3:${NC} Load L2 only for chosen documents      ${GREEN}→ precise${NC}"
echo ""
echo -e "  ${BOLD}Result: Agent reads full content only when needed.${NC}"
echo ""
pass "Namespace browser showcase complete."
