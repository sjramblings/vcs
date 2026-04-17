#!/usr/bin/env bash
set -euo pipefail

# Environment
VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}"
VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}"

# Colours
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Timing log for per-API-call data from child scripts
VCS_TIMING_LOG=$(mktemp /tmp/vcs-timing.XXXXXX)
export VCS_TIMING_LOG
trap "rm -f '$VCS_TIMING_LOG'" EXIT

header() { echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"; echo -e "${BOLD}${BLUE}  $1${NC}"; echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}\n"; }

header "VCS Showcase — Full Suite"
echo -e "${YELLOW}Running all 7 showcase scripts in order.${NC}"
echo -e "${YELLOW}This will take several minutes depending on API latency.${NC}\n"

SCRIPTS=(
  "01-ingestion-pipeline.sh"
  "02-semantic-search.sh"
  "03-namespace-browser.sh"
  "04-session-memory.sh"
  "05-token-efficiency.sh"
  "06-parent-rollup.sh"
  "07-agentcore-memory.sh"
)

LABELS=(
  "Ingestion Pipeline"
  "Semantic Search"
  "Namespace Browser"
  "Session Memory"
  "Token Efficiency"
  "Parent Rollup"
  "AgentCore Memory E2E"
)

TOTAL_START=$SECONDS
PASSED=0
FAILED=0
RESULTS=()

for i in "${!SCRIPTS[@]}"; do
  SCRIPT="${SCRIPTS[$i]}"
  LABEL="${LABELS[$i]}"

  header "[$((i+1))/${#SCRIPTS[@]}] ${LABEL}"

  SCRIPT_START=$SECONDS

  if bash "${SCRIPT_DIR}/${SCRIPT}"; then
    ELAPSED=$(( SECONDS - SCRIPT_START ))
    RESULTS+=("${GREEN}✓ ${LABEL} (${ELAPSED}s)${NC}")
    PASSED=$(( PASSED + 1 ))
  else
    ELAPSED=$(( SECONDS - SCRIPT_START ))
    RESULTS+=("${RED}✗ ${LABEL} (${ELAPSED}s)${NC}")
    FAILED=$(( FAILED + 1 ))
    echo -e "${RED}Script ${SCRIPT} failed — continuing with next script.${NC}"
  fi

  echo ""
done

TOTAL_ELAPSED=$(( SECONDS - TOTAL_START ))

# ─── Final summary ──────────────────────────────────────────────────

header "Showcase Results"

for RESULT in "${RESULTS[@]}"; do
  echo -e "  ${RESULT}"
done

echo ""
echo -e "${BOLD}  Total: ${PASSED} passed, ${FAILED} failed, ${TOTAL_ELAPSED}s elapsed${NC}"
echo ""

if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${BOLD}${GREEN}  All showcase scripts completed successfully.${NC}"
else
  echo -e "${BOLD}${RED}  ${FAILED} script(s) failed — review output above.${NC}"
fi

echo ""

# ─── API Call Timings ──────────────────────────────────────────────────
if [[ -s "$VCS_TIMING_LOG" ]]; then
  header "API Call Timings"

  # Column headers
  printf "  ${BOLD}%-28s %-20s %-6s %6s${NC}\n" "Script" "Endpoint" "Method" "Time"
  printf "  %-28s %-20s %-6s %6s\n" "----------------------------" "--------------------" "------" "------"

  # Print each timing line
  while IFS='|' read -r script endpoint method elapsed; do
    printf "  %-28s %-20s %-6s %5ss\n" "$script" "$endpoint" "$method" "$elapsed"
  done < "$VCS_TIMING_LOG"

  echo ""

  # Summary stats
  TOTAL_CALLS=$(wc -l < "$VCS_TIMING_LOG" | tr -d ' ')
  TOTAL_API_TIME=$(awk -F'|' '{sum+=$4} END {print sum}' "$VCS_TIMING_LOG")
  SLOWEST=$(sort -t'|' -k4 -rn "$VCS_TIMING_LOG" | head -1)
  SLOWEST_ENDPOINT=$(echo "$SLOWEST" | cut -d'|' -f2)
  SLOWEST_TIME=$(echo "$SLOWEST" | cut -d'|' -f4)

  echo -e "  ${BOLD}API calls: ${TOTAL_CALLS}, Total API time: ${TOTAL_API_TIME}s, Slowest: ${SLOWEST_ENDPOINT} (${SLOWEST_TIME}s)${NC}"
  echo ""
fi

# ─── Cleanup ───────────────────────────────────────────────────────────

API="$VCS_API_URL"
AUTH_H=(-H "x-api-key: $VCS_API_KEY" -H "Content-Type: application/json")

if [[ "${VCS_SHOWCASE_CLEANUP:-ask}" == "auto" ]]; then
  DO_CLEANUP=y
elif [[ "${VCS_SHOWCASE_CLEANUP:-ask}" == "skip" ]]; then
  DO_CLEANUP=n
else
  echo -e "${YELLOW}Clean up test data under viking://resources/showcase/ ? [y/N]${NC}"
  read -r DO_CLEANUP
fi

if [[ "$(echo "$DO_CLEANUP" | tr '[:upper:]' '[:lower:]')" == "y" ]]; then
  echo -e "${CYAN}▸ Deleting viking://resources/showcase/ ...${NC}"
  RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "${API}/fs/rm" \
    "${AUTH_H[@]}" \
    -G --data-urlencode "uri=viking://resources/showcase/")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    echo -e "${GREEN}✓ Cleanup complete — viking://resources/showcase/ deleted${NC}"
  else
    echo -e "${RED}✗ Cleanup failed (HTTP $HTTP_CODE)${NC}"
  fi
else
  echo -e "${YELLOW}  Skipping cleanup. To clean up manually:${NC}"
  echo -e "${YELLOW}  curl -X DELETE \"\${VCS_API_URL}/fs/rm?uri=viking://resources/showcase/\" -H \"x-api-key: \${VCS_API_KEY}\"${NC}"
fi

echo ""
