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

# ─── Helper: ingest document ──────────────────────────────────────

ingest() {
  local prefix="$1" filename="$2" content="$3"
  local encoded
  encoded=$(echo "$content" | base64)

  START_TIME=$SECONDS
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/resources" \
    "${AUTH[@]}" \
    -d "$(jq -n \
      --arg c "$encoded" \
      --arg p "$prefix" \
      --arg f "$filename" \
      '{content_base64: $c, uri_prefix: $p, filename: $f}')")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  ELAPSED=$(( SECONDS - START_TIME ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "06-parent-rollup|/resources|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "  ${filename} (${ELAPSED}s)"
  else
    fail "  ${filename} (HTTP $HTTP_CODE) (${ELAPSED}s)"
  fi
}

# ─── Helper: wait for parent rollup ──────────────────────────────

wait_for_rollup() {
  local uri="$1"
  local max_attempts=15
  local attempt=0

  step "Waiting for parent rollup on ${uri} ..."
  START_TIME=$SECONDS

  while [[ $attempt -lt $max_attempts ]]; do
    RESPONSE=$(curl -s -G "${API}/fs/read" \
      "${AUTH[@]}" \
      --data-urlencode "uri=$uri" \
      --data-urlencode "level=0" 2>/dev/null)

    CONTENT=$(echo "$RESPONSE" | jq -r '.content // ""' 2>/dev/null)
    TOKENS=$(echo "$RESPONSE" | jq '.tokens // 0' 2>/dev/null)

    if [[ -n "$CONTENT" && "$CONTENT" != "" && "$CONTENT" != "null" && "$TOKENS" -gt 0 ]]; then
      ELAPSED=$(( SECONDS - START_TIME ))
      [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "06-parent-rollup|/fs/read (rollup poll)|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"
      pass "Parent rollup complete (${TOKENS} tokens, ${ELAPSED}s)"
      return 0
    fi

    attempt=$(( attempt + 1 ))
    info "  Attempt ${attempt}/${max_attempts} — rollup not ready yet, waiting 3s..."
    sleep 3
  done

  ELAPSED=$(( SECONDS - START_TIME ))
  fail "Parent rollup did not complete within ${max_attempts} attempts (${ELAPSED}s)"
  return 1
}

# ─── Helper: read and display L0 ─────────────────────────────────

show_abstract() {
  local uri="$1" label="$2"

  START_TIME=$SECONDS
  RESPONSE=$(curl -s -G "${API}/fs/read" \
    "${AUTH[@]}" \
    --data-urlencode "uri=$uri" \
    --data-urlencode "level=0")
  ELAPSED=$(( SECONDS - START_TIME ))
  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "06-parent-rollup|/fs/read|GET|${ELAPSED}" >> "$VCS_TIMING_LOG"

  TOKENS=$(echo "$RESPONSE" | jq '.tokens // 0')
  CONTENT=$(echo "$RESPONSE" | jq -r '.content // "(no content)"')

  echo -e "\n  ${BOLD}${label}${NC} (${TOKENS} tokens, ${ELAPSED}s):"
  echo -e "  ${CYAN}${CONTENT}${NC}\n"
}

# ═══════════════════════════════════════════════════════════════════════
header "VCS Showcase: Parent Rollup"
echo -e "${YELLOW}Demonstrating how parent directories synthesise child abstracts.${NC}\n"

# ─── 1. Ingest Category A: Networking ─────────────────────────────

header "1. Ingest Category A: Networking (4 documents)"

PREFIX_A="viking://resources/showcase/rollup-test/category-a/"

ingest "$PREFIX_A" "vpc-peering.md" \
  "# VPC Peering

VPC peering creates a private network connection between two VPCs. Traffic stays on the AWS backbone and never traverses the public internet. I use peering for simple hub-and-spoke topologies with fewer than 10 VPCs. Beyond that, Transit Gateway is more manageable. Peering is non-transitive — if VPC A peers with B and B peers with C, A cannot reach C through B. Route tables must be updated on both sides. CIDR ranges cannot overlap. I always tag peering connections with the source and destination VPC names for clarity in the console."

ingest "$PREFIX_A" "transit-gateway.md" \
  "# Transit Gateway Architecture

Transit Gateway is the hub for connecting multiple VPCs, VPNs, and Direct Connect gateways. I deploy one per region and use route tables for segmentation: production VPCs in one route table, development in another, shared services accessible from both. Inter-region peering connects Transit Gateways across regions for global connectivity. The key advantage over VPC peering is centralised routing — add a new VPC by attaching it to the Transit Gateway and updating one route table instead of creating N-1 peering connections."

ingest "$PREFIX_A" "direct-connect.md" \
  "# Direct Connect for Hybrid Connectivity

Direct Connect provides a dedicated network connection from on-premises to AWS. I use 1 Gbps connections for most workloads, with a backup VPN connection for failover. The key benefit is consistent latency and throughput — unlike VPN, which traverses the public internet. I always deploy Direct Connect in two locations for redundancy. Virtual interfaces can be public (for accessing S3 and other public endpoints) or private (for VPC access). Cost is predictable: port-hour charges plus data transfer out, which is cheaper than internet-based transfer."

ingest "$PREFIX_A" "route53-dns.md" \
  "# Route 53 DNS Architecture

Route 53 is more than a DNS service — it is a global traffic management platform. I use hosted zones for domain management, health checks for endpoint monitoring, and routing policies for traffic distribution. Latency-based routing sends users to the nearest region. Weighted routing enables canary deployments. Failover routing with health checks provides automatic disaster recovery. Private hosted zones enable custom DNS within VPCs. I always enable DNSSEC for public zones and use alias records for AWS resources to avoid extra charges."

echo ""

# ─── 2. Wait for Category A parent rollup ────────────────────────

header "2. Wait for Category A Rollup"
wait_for_rollup "$PREFIX_A"

show_abstract "$PREFIX_A" "Category A (Networking) — Parent L0"

# ─── 3. Ingest Category B: Compute ───────────────────────────────

header "3. Ingest Category B: Compute (3 documents)"

PREFIX_B="viking://resources/showcase/rollup-test/category-b/"

ingest "$PREFIX_B" "ec2-instance-selection.md" \
  "# EC2 Instance Selection Guide

Choosing the right EC2 instance family is one of the most impactful decisions in AWS architecture. General purpose (M-series) handles 80% of workloads. Compute-optimised (C-series) for CPU-bound tasks like video encoding or scientific computing. Memory-optimised (R-series) for in-memory databases and caches. I always start with the latest generation — M7g or C7g on Graviton3 for 25% better price-performance. Right-sizing is an ongoing practice: use Compute Optimizer recommendations and CloudWatch CPU/memory metrics to identify over-provisioned instances quarterly."

ingest "$PREFIX_B" "auto-scaling-patterns.md" \
  "# Auto Scaling Patterns

Auto Scaling is essential for cost efficiency and availability. I use target tracking policies as the default — set target CPU at 60% and let AWS handle the math. Step scaling for more granular control when the relationship between metric and capacity is not linear. Predictive scaling for workloads with known patterns like daily traffic spikes. Warm pools reduce scale-out latency by keeping pre-initialised instances ready. I always set a minimum of 2 instances across 2 AZs for production workloads, and configure scale-in protection for instances handling long-running requests."

ingest "$PREFIX_B" "spot-instances.md" \
  "# Spot Instance Strategy

Spot instances offer up to 90% savings compared to on-demand pricing. The trade-off is that AWS can reclaim them with 2 minutes notice. I use Spot for stateless workloads: batch processing, CI/CD runners, data pipelines, and worker nodes in EKS. The key strategy is diversification — request capacity across multiple instance types and availability zones using Spot Fleet or mixed-instance ASGs. Capacity-optimised allocation strategy reduces interruption rates. I never run production APIs on Spot alone but use it alongside on-demand in a mixed fleet with 70% Spot and 30% on-demand baseline."

echo ""

# ─── 4. Wait for Category B parent rollup ────────────────────────

header "4. Wait for Category B Rollup"
wait_for_rollup "$PREFIX_B"

show_abstract "$PREFIX_B" "Category B (Compute) — Parent L0"

# ─── 5. Check grandparent rollup ─────────────────────────────────

GRANDPARENT="viking://resources/showcase/rollup-test/"

header "5. Wait for Grandparent Rollup"
wait_for_rollup "$GRANDPARENT"

show_abstract "$GRANDPARENT" "Grandparent (rollup-test/) — L0"

# ─── 6. Side-by-side comparison ──────────────────────────────────

header "6. Hierarchy at a Glance"

echo -e "${BOLD}  An agent scanning this namespace:${NC}\n"

echo -e "  ${BOLD}${CYAN}viking://resources/showcase/rollup-test/${NC}  (grandparent)"
show_abstract "$GRANDPARENT" "  Grandparent L0"

echo -e "  ${BOLD}${CYAN}├── category-a/${NC}  (networking)"
show_abstract "$PREFIX_A" "  Category A L0"

echo -e "  ${BOLD}${CYAN}└── category-b/${NC}  (compute)"
show_abstract "$PREFIX_B" "  Category B L0"

# ─── Summary ──────────────────────────────────────────────────────

header "Key Insight"
echo -e "${BOLD}${GREEN}  ┌─────────────────────────────────────────────────────────┐${NC}"
echo -e "${BOLD}${GREEN}  │  An agent can read ONE L0 abstract (~100 tokens) to     │${NC}"
echo -e "${BOLD}${GREEN}  │  understand an entire directory of documents.            │${NC}"
echo -e "${BOLD}${GREEN}  │                                                         │${NC}"
echo -e "${BOLD}${GREEN}  │  The grandparent abstract synthesises both categories    │${NC}"
echo -e "${BOLD}${GREEN}  │  — networking AND compute — in a single scan.            │${NC}"
echo -e "${BOLD}${GREEN}  │                                                         │${NC}"
echo -e "${BOLD}${GREEN}  │  No document was loaded at L2. The agent knows what      │${NC}"
echo -e "${BOLD}${GREEN}  │  is in this namespace without reading any full content.  │${NC}"
echo -e "${BOLD}${GREEN}  └─────────────────────────────────────────────────────────┘${NC}"
echo ""
pass "Parent rollup showcase complete."
