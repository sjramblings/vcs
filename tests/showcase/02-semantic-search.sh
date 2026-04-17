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

# ─── Search helper ──────────────────────────────────────────────────

run_search() {
  local number="$1"
  local query="$2"
  local specificity="$3"

  header "Search ${number}/5: \"${query}\" (${specificity})"

  START_TIME=$SECONDS

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/search/find" \
    "${AUTH[@]}" \
    -d "$(jq -n \
      --arg q "$query" \
      '{query: $q, max_results: 5, min_score: 0.1}')")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  ELAPSED=$(( SECONDS - START_TIME ))

  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "02-semantic-search|/search/find|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

  if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
    fail "Search failed (HTTP $HTTP_CODE)"
    echo "$BODY"
    return 1
  fi

  pass "Search completed in ${ELAPSED}s"
  echo ""

  # Display results ranked by score — API returns .results array
  RESULT_COUNT=$(echo "$BODY" | jq '[.results // [], .resources // [], .memories // []] | flatten | length')
  info "Results found: ${RESULT_COUNT}"
  echo ""

  echo "$BODY" | jq -r '
    [.results // [], .resources // [], .memories // []] | flatten | sort_by(-.score) | to_entries[] |
    "  \(.key + 1). [\(.value.score | tostring | .[0:5])] \(.value.uri)\n     \(.value.abstract // .value.content // "" | .[0:100])..."
  ' 2>/dev/null || echo "$BODY" | jq '.'

  echo ""

  # Highlight tokens saved
  TOKENS_SAVED=$(echo "$BODY" | jq '.tokens_saved_estimate // 0')
  echo -e "  ${BOLD}${GREEN}Tokens saved estimate: ${TOKENS_SAVED}${NC}"

  # Show trajectory if available
  TRAJECTORY=$(echo "$BODY" | jq '.trajectory // []')
  if [[ "$TRAJECTORY" != "[]" ]]; then
    echo ""
    info "Search trajectory:"
    echo "$TRAJECTORY" | jq -r '.[] | "    Step \(.step): \(.action) \(.uri // "") \(.candidates // "")"'
  fi

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════
header "VCS Showcase: Semantic Search"
echo -e "${YELLOW}Running 5 searches with increasing specificity against showcase docs.${NC}"
echo -e "${YELLOW}Prerequisite: run 01-ingestion-pipeline.sh first.${NC}\n"

run_search 1 "security"                                              "broad"
run_search 2 "IAM policies"                                          "medium"
run_search 3 "principle of least privilege"                           "specific"
run_search 4 "how does zero trust handle network perimeters"         "conceptual"
run_search 5 "what are the risks of shared credentials"              "practical"

# ─── Final summary ──────────────────────────────────────────────────
header "Summary"
echo -e "${BOLD}Observations:${NC}"
echo -e "  ${CYAN}1.${NC} Broad queries return all documents with lower scores"
echo -e "  ${CYAN}2.${NC} Specific queries surface the most relevant document first"
echo -e "  ${CYAN}3.${NC} Conceptual queries match against L0 abstracts, not keyword matching"
echo -e "  ${CYAN}4.${NC} tokens_saved_estimate shows the cost avoided by returning L0 instead of L2"
echo ""
pass "Semantic search showcase complete."
