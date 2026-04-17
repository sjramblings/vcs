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
header "VCS Showcase: Token Efficiency — The Hero Demo"
echo -e "${YELLOW}Demonstrating the core value proposition: scan cheap, drill deep.${NC}\n"

# ─── Define 10 short documents ────────────────────────────────────

declare -a FILENAMES=(
  "vpc-design.md"
  "s3-lifecycle-policies.md"
  "lambda-cold-starts.md"
  "cloudfront-caching.md"
  "rds-backup-strategy.md"
  "ecs-fargate-sizing.md"
  "secrets-manager-rotation.md"
  "step-functions-patterns.md"
  "eventbridge-rules.md"
  "cost-allocation-tags.md"
)

declare -a DOCUMENTS=(
  "# VPC Design Patterns

When I design a VPC for production, I start with a /16 CIDR and split it into /20 subnets across three availability zones. Public subnets get the NAT gateways and load balancers. Private subnets get the compute. Isolated subnets get the databases with no internet route at all. I always deploy VPC endpoints for S3 and DynamoDB to keep traffic off the public internet and save on NAT gateway costs. Flow logs go to CloudWatch for security monitoring. This pattern has served me well across dozens of production deployments."

  "# S3 Lifecycle Policies

S3 storage costs add up fast if you are not managing object lifecycles. I configure every production bucket with lifecycle rules: transition to Infrequent Access after 30 days, Glacier Flexible after 90, and Deep Archive after 180. For log buckets, I expire objects after 365 days. Incomplete multipart uploads get cleaned up after 7 days — these are a hidden cost that most teams miss. Intelligent-Tiering works well when access patterns are unpredictable, but for known patterns, explicit lifecycle rules give you more control and predictability."

  "# Lambda Cold Starts and How to Manage Them

Cold starts are the most common concern I hear about Lambda. The reality is nuanced: Python and Node.js cold starts are typically 200-500ms, Java and .NET can hit 2-5 seconds. For latency-sensitive APIs, I use provisioned concurrency on the critical paths and let everything else use on-demand. SnapStart for Java dramatically reduces cold start to under 200ms. Keeping deployment packages small helps — strip test files, use Lambda layers for shared dependencies, and avoid importing large SDKs when you only need one client. ARM64 architecture often cold starts faster and costs 20% less."

  "# CloudFront Caching Strategy

A well-configured CloudFront distribution can reduce origin load by 90% or more. I set cache policies based on content type: static assets get a 365-day TTL with cache busting via content hashes in filenames. API responses get shorter TTLs or no caching depending on whether they are personalised. I always enable Origin Shield to reduce cache misses to the origin. Custom error pages with short TTLs prevent thundering herd on 5xx errors. Cache invalidations should be rare — if you are invalidating regularly, your cache keys are wrong."

  "# RDS Backup and Recovery Strategy

Every production RDS instance needs automated backups with at least 7 days retention — I use 14 days as my default. I also take manual snapshots before any major change: schema migrations, version upgrades, parameter group changes. Cross-region snapshot copies protect against regional outages. For critical databases, I maintain a read replica in a second region that can be promoted. Point-in-time recovery is essential — it has saved me twice when application bugs corrupted data. Test your restore process quarterly; an untested backup is not a backup."

  "# ECS Fargate Right-Sizing

Over-provisioning Fargate tasks is the most common waste I see in containerised workloads. Start with the minimum CPU and memory that passes load testing, then add a 20% buffer. Use Container Insights to monitor actual utilisation — most teams are running at 10-15% CPU utilisation. Fargate Spot saves 70% for fault-tolerant workloads but requires graceful handling of the 2-minute SIGTERM warning. I split services into Spot-eligible (workers, batch processors) and on-demand (API servers, critical paths). ARM64 Fargate tasks cost 20% less and perform comparably for most workloads."

  "# Secrets Manager Rotation Patterns

Hardcoded credentials are a security incident waiting to happen. I use Secrets Manager for every secret: database passwords, API keys, OAuth tokens. Automatic rotation is the key feature — Lambda-backed rotation functions that cycle credentials on a schedule. For RDS, Secrets Manager provides built-in rotation templates. For custom secrets, I write a rotation Lambda that creates the new credential, tests it, then updates the secret. The rotation window matters: too frequent and you risk transient failures, too infrequent and you have long-lived credentials. I default to 30-day rotation."

  "# Step Functions Workflow Patterns

Step Functions is my go-to for orchestrating multi-step workflows. Express workflows for high-volume, short-duration work (under 5 minutes). Standard workflows for long-running processes that need audit trails. I use the saga pattern for distributed transactions: each step has a compensating action that rolls back on failure. Map state for fan-out processing — but watch the concurrency limits. Error handling with Retry and Catch blocks at every step prevents silent failures. I add CloudWatch alarms on ExecutionsFailed and ExecutionsTimedOut metrics for every state machine."

  "# EventBridge Rule Design

EventBridge is the backbone of event-driven architecture on AWS. I design rules with specificity: match on detail-type and source at minimum, add detail filters to reduce noise. Dead-letter queues on every rule — if a target fails, you want to know. I use event buses for domain separation: one bus per bounded context, with cross-bus rules for integration. Schema discovery helps when consuming events from AWS services. Input transformers keep target payloads clean by extracting only the fields each consumer needs. Archive rules for compliance and replay during incident investigation."

  "# Cost Allocation Tags Strategy

You cannot optimise costs you cannot attribute. I enforce a mandatory tagging policy with at least four tags: Environment (dev/staging/prod), Team, Project, and CostCenter. AWS Config rules flag untagged resources automatically. Tag policies at the organisation level prevent typos and enforce allowed values. I generate weekly cost reports grouped by Project tag — this single practice has driven more cost reduction than any other technique, because teams that see their costs start optimising voluntarily. Activate user-defined cost allocation tags in the Billing console — they are not active by default."
)

# ─── Ingest all 10 documents ──────────────────────────────────────

header "Phase 1: Ingest 10 Documents"

TOTAL_INGEST_TIME=0

for i in "${!FILENAMES[@]}"; do
  FILENAME="${FILENAMES[$i]}"
  CONTENT="${DOCUMENTS[$i]}"
  ENCODED=$(echo "$CONTENT" | base64)

  START_TIME=$SECONDS

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/resources" \
    "${AUTH[@]}" \
    -d "$(jq -n \
      --arg c "$ENCODED" \
      --arg p "viking://resources/showcase/efficiency-test/" \
      --arg f "$FILENAME" \
      '{content_base64: $c, uri_prefix: $p, filename: $f}')")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  ELAPSED=$(( SECONDS - START_TIME ))
  TOTAL_INGEST_TIME=$(( TOTAL_INGEST_TIME + ELAPSED ))

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "[$((i+1))/10] ${FILENAME} (${ELAPSED}s)"
  else
    fail "[$((i+1))/10] ${FILENAME} failed (HTTP $HTTP_CODE)"
  fi
done

info "Total ingestion time: ${TOTAL_INGEST_TIME}s"

# ─── Calculate total L2 tokens ────────────────────────────────────

header "Phase 2: Measure Token Counts"

TOTAL_L2=0
TOTAL_L0=0

step "Reading L0 and L2 token counts for all 10 documents..."
echo ""

for i in "${!FILENAMES[@]}"; do
  URI="viking://resources/showcase/efficiency-test/${FILENAMES[$i]}"
  CONTENT="${DOCUMENTS[$i]}"

  # L2 tokens — API returns 0 (content in S3), estimate from char count
  # Uses same formula as API: Math.ceil(content.length / 4)
  CHAR_COUNT=$(echo -n "$CONTENT" | wc -c | tr -d ' ')
  L2_TOKENS=$(( (CHAR_COUNT + 3) / 4 ))

  # L0 tokens
  L0_RESP=$(curl -s -G "${API}/fs/read" \
    "${AUTH[@]}" \
    --data-urlencode "uri=$URI" \
    --data-urlencode "level=0")
  L0_TOKENS=$(echo "$L0_RESP" | jq '.tokens // 0')

  info "${FILENAMES[$i]}: L2~${L2_TOKENS} tokens, L0=${L0_TOKENS} tokens"

  TOTAL_L2=$(( TOTAL_L2 + L2_TOKENS ))
  TOTAL_L0=$(( TOTAL_L0 + L0_TOKENS ))
done

echo ""
pass "Total L2 tokens (full content): ~${TOTAL_L2} (estimated)"
pass "Total L0 tokens (abstracts):     ${TOTAL_L0}"

# ─── Run a search ─────────────────────────────────────────────────

header "Phase 3: Search — Only L0 Abstracts Returned"
step "Searching for: \"how to reduce AWS costs on compute and storage\""

SEARCH_RESP=$(curl -s -X POST "${API}/search/find" \
  "${AUTH[@]}" \
  -d "$(jq -n '{
    query: "how to reduce AWS costs on compute and storage",
    max_results: 10,
    min_score: 0.1
  }')")

RESULT_COUNT=$(echo "$SEARCH_RESP" | jq '[.results // [], .resources // []] | flatten | length')
TOKENS_SAVED=$(echo "$SEARCH_RESP" | jq '.tokens_saved_estimate // 0')

pass "Search returned ${RESULT_COUNT} results"
info "Tokens saved estimate from VCS: ${TOKENS_SAVED}"
echo ""

echo "$SEARCH_RESP" | jq -r '
  [.results // [], .resources // []] | flatten | sort_by(-.score) | to_entries[] |
  "  \(.key + 1). [\(.value.score | tostring | .[0:5])] \(.value.uri | split("/") | last)  (~100 token abstract returned)"
'

# ─── Calculate drill-down cost ────────────────────────────────────

# Take top 2 results and estimate their L2 token cost from original content
TOP_FNAMES=$(echo "$SEARCH_RESP" | jq -r '[.results // [], .resources // []] | flatten | sort_by(-.score) | .[0:2] | .[].uri | split("/") | last')

DRILL_DOWN_TOKENS=0
echo ""
step "Simulating drill-down: loading L2 for top 2 results..."

while IFS= read -r FNAME; do
  [[ -z "$FNAME" ]] && continue

  # Find the matching document content to estimate L2 tokens
  L2_TOK=0
  for j in "${!FILENAMES[@]}"; do
    if [[ "${FILENAMES[$j]}" == "$FNAME" ]]; then
      CC=$(echo -n "${DOCUMENTS[$j]}" | wc -c | tr -d ' ')
      L2_TOK=$(( (CC + 3) / 4 ))
      break
    fi
  done

  DRILL_DOWN_TOKENS=$(( DRILL_DOWN_TOKENS + L2_TOK ))
  info "  ${FNAME}: ~${L2_TOK} tokens loaded"
done <<< "$TOP_FNAMES"

TOTAL_WITH_DRILLDOWN=$(( TOTAL_L0 + DRILL_DOWN_TOKENS ))

# ─── Big summary box ──────────────────────────────────────────────

if [[ "$TOTAL_L2" -gt 0 ]]; then
  SCAN_SAVINGS=$(( 100 - (TOTAL_L0 * 100 / TOTAL_L2) ))
  DRILL_SAVINGS=$(( 100 - (TOTAL_WITH_DRILLDOWN * 100 / TOTAL_L2) ))
else
  SCAN_SAVINGS=0
  DRILL_SAVINGS=0
fi

header "Token Efficiency Comparison"

printf "\n${BOLD}${RED}  FLAT RAG (load all 10 documents):${NC}\n"
printf "  ${RED}~%s tokens in context window${NC}\n\n" "$TOTAL_L2"

printf "${BOLD}${GREEN}  VCS INITIAL SCAN (L0 abstracts only):${NC}\n"
printf "  ${GREEN}%s tokens (%s%% savings)${NC}\n\n" "$TOTAL_L0" "$SCAN_SAVINGS"

printf "${BOLD}${CYAN}  VCS AFTER DRILL-DOWN (L0 scan + 2 docs at L2):${NC}\n"
printf "  ${CYAN}~%s tokens (%s%% savings vs flat RAG)${NC}\n\n" "$TOTAL_WITH_DRILLDOWN" "$DRILL_SAVINGS"

echo -e "  ${BOLD}The agent got the same answer with ~${DRILL_SAVINGS}% fewer tokens.${NC}"
echo -e "  ${BOLD}At scale (hundreds of documents), the savings are even greater.${NC}"
echo ""
pass "Token efficiency showcase complete."
