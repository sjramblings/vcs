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

# ─── Document content ───────────────────────────────────────────────

read -r -d '' DOC_CLOUD_SECURITY << 'CONTENT' || true
# Cloud Security Fundamentals

As a cloud engineer who has spent the better part of a decade building and securing workloads on AWS, I can tell you that cloud security is not a single technology — it is a discipline. Getting it right requires understanding shared responsibility, defence in depth, and the principle of least privilege at every layer of your stack.

## The Shared Responsibility Model

AWS secures the infrastructure — the hypervisor, the physical hosts, the network fabric. Everything above that line is yours. Your IAM policies, your security groups, your encryption choices, your application code. I have seen teams assume that "being on AWS" means they are secure. It does not. AWS gives you the tools; you still have to use them correctly.

## Defence in Depth

Never rely on a single control. A well-architected environment layers security: network segmentation via VPCs, identity boundaries via IAM, encryption at rest and in transit, logging via CloudTrail and VPC Flow Logs, and runtime monitoring through GuardDuty. Each layer catches what the others miss. I design every environment with the assumption that any single control can fail.

## Encryption Everywhere

KMS-managed keys should be the default for every data store — S3, DynamoDB, EBS, RDS. Use AWS-managed keys for simplicity or customer-managed keys when you need rotation control and cross-account access. TLS 1.2 minimum for data in transit. Certificate Manager makes this free and automatic for public-facing endpoints.

## Logging and Visibility

You cannot secure what you cannot see. CloudTrail for API-level audit, Config for resource compliance, GuardDuty for threat detection, and Security Hub to aggregate findings. I set up these four services on day one of every new account. The cost is negligible compared to the cost of a breach you did not detect.

## Incident Response Readiness

Have a runbook before you need one. Know how to isolate a compromised instance, rotate credentials, and preserve forensic evidence. Automate what you can — Lambda-backed Config rules that auto-remediate public S3 buckets or overly permissive security groups save time and prevent human error.

Security is not a feature you bolt on at the end. It is a practice you embed in every design decision, every deployment pipeline, and every code review. Start with least privilege, layer your controls, log everything, and assume breach. That mindset will carry you further than any single tool.
CONTENT

read -r -d '' DOC_IAM << 'CONTENT' || true
# IAM Best Practices for Production AWS Environments

Identity and Access Management is the front door to your entire AWS estate. Get IAM wrong and nothing else matters — your encryption, your network segmentation, your monitoring — all of it becomes irrelevant if an attacker can assume a role with admin privileges.

## Start With Zero Trust in IAM

Every principal starts with zero permissions. Explicit deny always wins. I build IAM policies by starting with nothing and adding only the specific actions needed for a workload to function. This is tedious but it is the only approach that scales safely. Wildcards in the Action or Resource field of a policy are a code smell that should trigger a review.

## Use Roles, Not Long-Lived Credentials

IAM users with access keys are a liability. Every access key is a secret that can leak. Instead, use IAM roles with temporary credentials — for EC2 via instance profiles, for Lambda via execution roles, for cross-account access via role assumption with external IDs. I have eliminated long-lived credentials from every production environment I manage.

## Policy Structure and Boundaries

Use service control policies at the organization level to set hard guardrails. Use permission boundaries on roles to cap maximum privileges even when inline policies are attached. Structure your policies in layers: SCPs for account-wide denies, permission boundaries for role-level caps, identity policies for grants, and resource policies for cross-account sharing.

## Condition Keys Are Underused

Most teams stop at Action and Resource. The real power is in Condition blocks. Restrict by source IP, require MFA, enforce encryption context on KMS calls, limit S3 operations to specific prefixes. Condition keys turn a broad policy into a surgical one. I use aws:PrincipalOrgID on every resource policy to prevent confused-deputy attacks.

## Audit and Rotation

Enable IAM Access Analyzer in every region. Review its findings weekly. Use credential reports to find unused users and stale keys. Rotate secrets on a schedule — not because the old ones are compromised, but because rotation proves your system can handle it. If rotating a key breaks something, you have found a fragile dependency before an attacker did.

## Common Anti-Patterns

Sharing IAM users across team members. Using the root account for anything other than initial setup and break-glass. Attaching AdministratorAccess to Lambda execution roles. Granting s3:* when s3:GetObject on a single bucket would suffice. Each of these is a real-world pattern I have encountered — and remediated — in production environments.

IAM is not glamorous work. There is no dashboard that makes it exciting. But it is the single most impactful security investment you can make in AWS. Nail your IAM practices and the rest of your security posture follows naturally.
CONTENT

read -r -d '' DOC_ZERO_TRUST << 'CONTENT' || true
# Zero Trust Architecture in Practice

Zero trust is not a product you can buy. It is an architectural philosophy: never trust, always verify. Every request — whether it comes from inside your network or outside — must prove its identity, demonstrate authorisation, and be logged for audit. Having implemented zero trust patterns across multiple AWS environments, I can share what works and what is mostly marketing.

## The Death of the Network Perimeter

Traditional security drew a hard line: inside the firewall is trusted, outside is not. Cloud demolished that model. Your workloads run on shared infrastructure. Your developers work from home. Your APIs are called by third-party services. There is no meaningful "inside" anymore. Zero trust accepts this reality and moves the trust boundary to every individual request.

## Identity as the New Perimeter

In a zero trust model, identity replaces network position as the primary security control. Every service-to-service call authenticates via IAM roles or mTLS. Every user request carries a verified token. Every API gateway validates the caller before routing. I implement this on AWS using a combination of IAM roles for service identity, Cognito or custom authorisers for user identity, and VPC endpoints to keep traffic off the public internet while still authenticating every request.

## Microsegmentation

Instead of a flat network with broad security groups, zero trust demands microsegmentation. Each service gets its own security group that allows only the specific ports and source groups it needs. In practice, I create one security group per service and wire them together explicitly. A compromised web server cannot reach the database directly — it must go through the API layer, which enforces its own authorisation.

## Continuous Verification

Authentication at the front door is not enough. Zero trust verifies continuously: is this session still valid, has the user's risk score changed, does this request pattern match normal behaviour. On AWS, I layer GuardDuty anomaly detection with custom CloudWatch metrics that flag unusual API call patterns. A Lambda that suddenly starts calling IAM:CreateUser is suspicious regardless of whether its role technically allows it.

## Practical Implementation Steps

Start with an identity provider and enforce MFA everywhere. Map your data flows to understand which services talk to which. Replace security-group-level trust with explicit service mesh authentication. Log every request. Build detection rules for lateral movement. Accept that zero trust is a journey — you will not achieve it in a sprint, but every step reduces your attack surface.

## What Zero Trust Is Not

It is not a firewall product with a new label. It is not simply adding MFA to your VPN. It is not achievable by purchasing a single vendor solution. Zero trust is a design principle that touches identity, network, application, and data layers simultaneously. Any vendor claiming to "deliver zero trust" in a box is selling you confidence you have not earned.

The shift to zero trust is the most significant architectural change in enterprise security this decade. It is hard, it is incremental, and it is absolutely necessary. Start with identity, extend to network, verify continuously, and never stop auditing.
CONTENT

# ─── Helper: ingest a document ──────────────────────────────────────

ingest_doc() {
  local filename="$1"
  local content="$2"
  local encoded
  encoded=$(echo "$content" | base64)

  step "Ingesting $filename ..."
  START_TIME=$SECONDS

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/resources" \
    "${AUTH[@]}" \
    -d "$(jq -n \
      --arg c "$encoded" \
      --arg p "viking://resources/showcase/docs/" \
      --arg f "$filename" \
      '{content_base64: $c, uri_prefix: $p, filename: $f}')")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  ELAPSED=$(( SECONDS - START_TIME ))

  [[ -n "${VCS_TIMING_LOG:-}" ]] && echo "01-ingestion-pipeline|/resources|POST|${ELAPSED}" >> "$VCS_TIMING_LOG"

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "Ingested $filename (${ELAPSED}s, HTTP $HTTP_CODE)"
    echo "$BODY" | jq '.'
  else
    fail "Failed to ingest $filename (HTTP $HTTP_CODE)"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    return 1
  fi
}

# ─── Helper: read a document at a given level ───────────────────────

read_level() {
  local uri="$1"
  local level="$2"
  local label="$3"
  local original_content="${4:-}"

  RESPONSE=$(curl -s -w "\n%{http_code}" -G "${API}/fs/read" \
    "${AUTH[@]}" \
    --data-urlencode "uri=$uri" \
    --data-urlencode "level=$level")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    TOKENS=$(echo "$BODY" | jq '.tokens // 0')

    if [[ "$level" == "2" ]]; then
      # L2 content lives in S3 — API returns empty content with s3_key.
      # Estimate tokens from original content using same formula as API:
      # Math.ceil(content.length / 4) — characters divided by 4.
      if [[ -n "$original_content" ]]; then
        CHAR_COUNT=$(echo -n "$original_content" | wc -c | tr -d ' ')
        TOKENS=$(( (CHAR_COUNT + 3) / 4 ))
      fi
      info "$label (L${level}): ~${TOKENS} tokens (stored in S3)" >&2
      info "  [Full content stored at $(echo "$BODY" | jq -r '.s3_key // "S3"')]" >&2
    elif [[ "$level" == "1" ]]; then
      # L1 is a JSON array of sections — format nicely
      SECTION_COUNT=$(echo "$BODY" | jq -r '.content' | jq 'length' 2>/dev/null || echo "?")
      FIRST_TITLE=$(echo "$BODY" | jq -r '.content' | jq -r '.[0].title // empty' 2>/dev/null || echo "")
      info "$label (L${level}): ${TOKENS} tokens (${SECTION_COUNT} sections)" >&2
      if [[ -n "$FIRST_TITLE" ]]; then
        info "  Sections: ${FIRST_TITLE}, ..." >&2
      fi
    else
      # L0 — plain text abstract
      CONTENT_PREVIEW=$(echo "$BODY" | jq -r '.content' | head -3)
      info "$label (L${level}): ${TOKENS} tokens" >&2
      info "  ${CONTENT_PREVIEW:0:120}..." >&2
    fi

    echo "$TOKENS"
  else
    fail "Failed to read $uri at L${level} (HTTP $HTTP_CODE)" >&2
    echo "0"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
header "VCS Showcase: Ingestion Pipeline"
echo -e "${YELLOW}Ingesting 3 cloud security documents and inspecting L0/L1/L2 tiers${NC}\n"

TOTAL_L2_TOKENS=0
TOTAL_L0_TOKENS=0

DOCS=("cloud-security-basics.md" "iam-best-practices.md" "zero-trust-architecture.md")
CONTENTS=("$DOC_CLOUD_SECURITY" "$DOC_IAM" "$DOC_ZERO_TRUST")

for i in 0 1 2; do
  FILENAME="${DOCS[$i]}"
  CONTENT="${CONTENTS[$i]}"
  URI="viking://resources/showcase/docs/${FILENAME}"

  header "Document $((i+1))/3: ${FILENAME}"

  ingest_doc "$FILENAME" "$CONTENT"

  echo ""
  step "Reading back at all 3 levels..."

  L0_TOKENS=$(read_level "$URI" 0 "Abstract")
  L1_TOKENS=$(read_level "$URI" 1 "Overview")
  L2_TOKENS=$(read_level "$URI" 2 "Full content" "$CONTENT")

  # Accumulate (strip quotes if jq returns a string)
  L0_TOKENS=${L0_TOKENS//\"/}
  L2_TOKENS=${L2_TOKENS//\"/}
  TOTAL_L0_TOKENS=$(( TOTAL_L0_TOKENS + ${L0_TOKENS:-0} ))
  TOTAL_L2_TOKENS=$(( TOTAL_L2_TOKENS + ${L2_TOKENS:-0} ))

  echo ""
done

# ─── Final summary ──────────────────────────────────────────────────

if [[ "$TOTAL_L2_TOKENS" -gt 0 ]]; then
  REDUCTION=$(( 100 - (TOTAL_L0_TOKENS * 100 / TOTAL_L2_TOKENS) ))
else
  REDUCTION=0
fi

header "Summary"
echo -e "${BOLD}${GREEN}  3 documents ingested${NC}"
echo -e "${BOLD}${GREEN}  ~${TOTAL_L2_TOKENS} total tokens at L2 (full content, estimated)${NC}"
echo -e "${BOLD}${GREEN}  ${TOTAL_L0_TOKENS} total tokens at L0 (abstracts)${NC}"
echo -e "${BOLD}${GREEN}  ~${REDUCTION}% reduction from L2 → L0${NC}"
echo ""
pass "Ingestion pipeline showcase complete."
