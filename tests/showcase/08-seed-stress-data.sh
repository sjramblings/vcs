#!/usr/bin/env bash
set -euo pipefail

# ─── Stress-test data seeder for VCS ─────────────────────────────────
# Creates a realistic dataset for evaluation and load testing:
#   - 5 resource documents across 3 namespaces
#   - 5 sessions with 6-8 messages each (diverse topics)
#   - Triggers AgentCore memory extraction for each session
#
# Usage: VCS_API_URL=... VCS_API_KEY=... bash 08-seed-stress-data.sh
# Time: ~3-5 minutes (mostly Bedrock latency)

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

DOCS_CREATED=0
SESSIONS_CREATED=0
MESSAGES_SENT=0
COMMITS_DONE=0
ERRORS=0

# ─── Helper: create directories ──────────────────────────────────────

create_dir() {
  local uri="$1"
  local ctx_type="${2:-resource}"
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/fs/mkdir" \
    "${AUTH[@]}" \
    -d "{\"uri\": \"${uri}\", \"context_type\": \"${ctx_type}\"}")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "Created: ${uri}"
  else
    info "Dir exists or failed: ${uri} (HTTP ${HTTP_CODE})"
  fi
}

# ─── Helper: ingest document ─────────────────────────────────────────

ingest_doc() {
  local uri_prefix="$1"
  local filename="$2"
  local content="$3"
  local instruction="${4:-Summarise this technical document}"

  local encoded=$(echo -n "$content" | base64)

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/resources" \
    "${AUTH[@]}" \
    -d "{
      \"uri_prefix\": \"${uri_prefix}\",
      \"filename\": \"${filename}\",
      \"content_base64\": \"${encoded}\",
      \"instruction\": \"${instruction}\"
    }")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "Ingested: ${uri_prefix}${filename}"
    DOCS_CREATED=$((DOCS_CREATED + 1))
  else
    fail "Ingest failed: ${uri_prefix}${filename} (HTTP ${HTTP_CODE})"
    ERRORS=$((ERRORS + 1))
  fi
}

# ─── Helper: create session with messages ────────────────────────────

create_session_with_messages() {
  local topic="$1"
  shift
  local messages=("$@")

  # Create session
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions" "${AUTH[@]}")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  SESSION_ID=$(echo "$BODY" | jq -r '.session_id')

  if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
    fail "Session create failed for topic: ${topic}"
    ERRORS=$((ERRORS + 1))
    return
  fi
  SESSIONS_CREATED=$((SESSIONS_CREATED + 1))

  # Add messages
  for msg in "${messages[@]}"; do
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions/${SESSION_ID}/messages" \
      "${AUTH[@]}" -d "$msg")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    if [[ "$HTTP_CODE" =~ ^2 ]]; then
      MESSAGES_SENT=$((MESSAGES_SENT + 1))
    else
      ERRORS=$((ERRORS + 1))
    fi
  done

  # Commit
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API}/sessions/${SESSION_ID}/commit" "${AUTH[@]}")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    COMMITS_DONE=$((COMMITS_DONE + 1))
    pass "Session committed: ${topic} (${SESSION_ID})"
  else
    fail "Commit failed: ${topic} (HTTP ${HTTP_CODE})"
    ERRORS=$((ERRORS + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════════════
header "VCS Stress-Test Data Seeder"
echo -e "${YELLOW}Creating realistic dataset for evaluation and load testing.${NC}"
echo -e "${YELLOW}This will take 3-5 minutes (Bedrock inference latency).${NC}\n"

# ─── 1. Create namespace directories ─────────────────────────────────

header "1. Create Namespace Directories"

create_dir "viking://resources/docs/" "resource"
create_dir "viking://resources/docs/aws/" "resource"
create_dir "viking://resources/docs/typescript/" "resource"
create_dir "viking://resources/docs/architecture/" "resource"
create_dir "viking://resources/runbooks/" "resource"

# ─── 2. Ingest resource documents ────────────────────────────────────

header "2. Ingest Resource Documents"

step "Ingesting 5 technical documents..."

ingest_doc "viking://resources/docs/aws/" "lambda-best-practices.md" \
"# AWS Lambda Best Practices

## Memory and CPU Allocation
Lambda allocates CPU proportional to memory. At 1769MB you get a full vCPU. For compute-intensive tasks, increasing memory to 256MB or 512MB often reduces total cost because execution time drops significantly.

## Cold Start Optimization
- Use arm64 (Graviton2) for 20% better price-performance
- Minimize deployment package size with esbuild tree-shaking
- Use provisioned concurrency for latency-sensitive APIs (adds cost)
- Avoid VPC unless required — adds 2-10s cold start penalty

## Error Handling
Always implement structured error handling with try/catch at the handler level. Use Powertools Logger for structured JSON logs and Tracer for X-Ray tracing. Dead letter queues (SQS or SNS) catch async invocation failures.

## Environment Variables
Store configuration in environment variables, not hardcoded. Use SSM Parameter Store for secrets and cross-service values. Lambda caches env vars across warm invocations.

## Idempotency
Event-driven Lambdas must handle duplicate events. Use DynamoDB conditional writes or idempotency tokens. SQS FIFO queues provide exactly-once processing via deduplication IDs."

ingest_doc "viking://resources/docs/aws/" "dynamodb-patterns.md" \
"# DynamoDB Access Patterns

## Single Table Design
Use a single table with composite keys (PK + SK) to model multiple entity types. This reduces the number of tables and enables efficient queries across related entities.

### Common Key Patterns
- PK=userId, SK=metadata#profile — user profile
- PK=userId, SK=order#timestamp — user orders (sorted by time)
- PK=orderId, SK=item#productId — order line items

## GSI Strategies
- GSI1: Inverted index (SK becomes PK) for reverse lookups
- GSI2: Sparse index with filter conditions for status-based queries
- Use projections to minimize GSI storage cost

## Capacity Management
- On-demand billing for unpredictable workloads (pay per request)
- Provisioned capacity with auto-scaling for steady-state workloads
- Reserved capacity for significant cost savings (1-3 year commitment)

## Consistency Model
- Eventually consistent reads are 50% cheaper and sufficient for most reads
- Strongly consistent reads for critical operations (inventory checks, financial transactions)
- Transactional writes for multi-item atomic operations (2x write cost)"

ingest_doc "viking://resources/docs/typescript/" "error-handling.md" \
"# TypeScript Error Handling Patterns

## Custom Error Classes
Create domain-specific error classes extending Error. Include error codes, HTTP status mappings, and structured metadata for debugging.

\`\`\`typescript
export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
  constructor(resource: string, id: string) {
    super(\`\${resource} not found: \${id}\`);
    this.name = 'NotFoundError';
  }
}
\`\`\`

## Result Types
Use discriminated unions for operations that can fail predictably:
\`\`\`typescript
type Result<T> = { success: true; data: T } | { success: false; error: string };
\`\`\`

## Zod Validation
Use Zod schemas for runtime validation of external data (API requests, environment variables, SDK responses). Zod provides type inference, so validated data is automatically typed.

## Error Boundaries
- Validate at system boundaries (API input, SDK responses, file I/O)
- Trust internal function contracts (no defensive checks inside modules)
- Log errors with structured context (request ID, user ID, operation)"

ingest_doc "viking://resources/docs/architecture/" "event-driven-patterns.md" \
"# Event-Driven Architecture Patterns

## Pub/Sub with SNS
Use SNS topics for fan-out messaging. Each subscriber processes events independently. Supports Lambda, SQS, HTTP endpoints, and email as targets.

### SNS Best Practices
- Use message filtering to reduce unnecessary Lambda invocations
- Configure DLQ on subscriptions for failed deliveries
- Use FIFO topics when message ordering matters within a group

## Queue-Based Processing with SQS
SQS decouples producers from consumers. Standard queues provide at-least-once delivery with best-effort ordering. FIFO queues guarantee exactly-once processing.

### SQS Patterns
- Batch processing: Configure Lambda to process up to 10 messages per invocation
- Visibility timeout: Set to 6x your function timeout
- DLQ with maxReceiveCount: 3 for poison pill isolation
- Content-based deduplication in FIFO queues eliminates explicit dedup IDs

## EventBridge
EventBridge enables event routing with content-based filtering rules. Use for cross-service integration and scheduled tasks (cron).

## Saga Pattern
For distributed transactions across multiple services, implement compensating transactions. Each step has a corresponding undo operation. Step Functions orchestrate the saga with error handling and rollback."

ingest_doc "viking://resources/runbooks/" "incident-response.md" \
"# Incident Response Runbook

## Severity Classification
- P1 (Critical): Service completely down, data loss risk. Response: 15 min.
- P2 (High): Major feature broken, significant user impact. Response: 1 hour.
- P3 (Medium): Minor feature broken, workaround available. Response: 4 hours.
- P4 (Low): Cosmetic issue, no functional impact. Response: Next sprint.

## Initial Triage Checklist
1. Check CloudWatch dashboard for error rate spikes
2. Check recent deployments (last 2 hours) — rollback candidate?
3. Check DLQ depth — are messages failing silently?
4. Check Lambda cold starts — provisioned concurrency exhausted?
5. Check DynamoDB throttling — ProvisionedThroughputExceededException?
6. Check S3 Vectors — query latency or access denied?

## Rollback Procedure
1. Identify the breaking commit: git log --oneline --since='2 hours ago'
2. CDK rollback: cdk deploy --rollback
3. If CDK rollback fails: manually update Lambda function code via console
4. Verify: run showcase test suite to confirm recovery

## Post-Incident
- Create incident report within 24 hours
- Update runbook with new failure mode
- Add monitoring for the specific failure pattern"

# ─── 3. Create sessions with diverse topics ──────────────────────────

header "3. Create Sessions (6 messages each for AgentCore extraction)"

# Session 1: Infrastructure preferences
step "Session 1: Infrastructure tooling preferences"
create_session_with_messages "Infrastructure preferences" \
  '{"role":"user","parts":[{"type":"text","content":"I need to set up monitoring for our Lambda functions. We have 12 functions in production."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"For 12 Lambda functions, I recommend CloudWatch embedded metrics with Powertools. Set up a single dashboard with error rates, duration percentiles (P50/P99), and invocation counts per function. Add alarms for error rate > 1% and P99 duration > 5s."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"Good plan. I always use Powertools for all Lambda functions — Logger, Tracer, and Metrics. It is our team standard. We also always deploy with CDK, never SAM."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Powertools is an excellent team standard. With CDK you can define the dashboard as code and keep alarms version-controlled. Consider adding a DLQ depth alarm for any async event-driven functions."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"Yes, every event-driven Lambda in our stack has a DLQ with an alarm. It is a non-negotiable pattern for us. We also use arm64 for all functions to save cost."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Those are solid engineering standards — Powertools, CDK, DLQs with alarms, and arm64. Having these as non-negotiable team patterns reduces operational surprises significantly."}]}'

# Session 2: Database design discussion
step "Session 2: DynamoDB design patterns"
create_session_with_messages "DynamoDB design" \
  '{"role":"user","parts":[{"type":"text","content":"We are designing a new feature that needs to store user preferences. Should we use a separate DynamoDB table or add to our existing single-table design?"}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"For user preferences, I recommend keeping them in your existing single-table. Use PK=userId, SK=pref#category to store preferences by category. This avoids table proliferation and lets you query all user data in one operation."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"Makes sense. I prefer on-demand billing for DynamoDB — we have unpredictable traffic patterns and I do not want to manage capacity."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"On-demand is the right call for unpredictable traffic. You pay about 5x more per request compared to provisioned, but you never deal with throttling or capacity planning. For your traffic pattern, the operational simplicity is worth the cost premium."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"Exactly. We also always enable point-in-time recovery on all production tables. Lost a table once without it — never again."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Point-in-time recovery is essential insurance. The cost is negligible compared to the risk of data loss. Combined with DynamoDB Streams for change capture, you get a complete recovery and audit story."}]}'

# Session 3: Security practices
step "Session 3: AWS security patterns"
create_session_with_messages "Security practices" \
  '{"role":"user","parts":[{"type":"text","content":"I am reviewing our IAM policies. We have some wildcard permissions that concern me."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Wildcard permissions are a common security debt. Start by running IAM Access Analyzer to identify overly permissive policies. Then narrow each policy to the minimum required actions and resource ARNs."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"I follow strict least-privilege for all IAM. Every Lambda gets its own execution role with only the specific actions and resource ARNs it needs. No wildcards ever."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Per-function execution roles with explicit resource ARNs is best practice. Add condition keys like aws:SourceAccount for service-to-service calls to prevent confused deputy attacks."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"We also rotate API keys quarterly and never store secrets in environment variables — everything goes through SSM Parameter Store with encryption."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"SSM Parameter Store with encryption is the right approach. For highly sensitive values, consider Secrets Manager which adds automatic rotation. The quarterly key rotation is good — automate it if you have not already."}]}'

# Session 4: Testing strategy
step "Session 4: Testing approaches"
create_session_with_messages "Testing strategy" \
  '{"role":"user","parts":[{"type":"text","content":"We need to improve our test coverage. Currently we only have unit tests. What integration testing approach do you recommend?"}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"For AWS serverless, I recommend a three-tier approach: unit tests with mocked AWS SDK, integration tests against real AWS services in a dev account, and end-to-end tests via API calls. Use vitest for unit tests and shell scripts with curl for E2E."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"I prefer vitest over jest — it is faster and the API is cleaner. We use vi.mock and vi.hoisted for all our SDK mocking."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Vitest is excellent for TypeScript Lambda testing. The vi.hoisted pattern ensures mocks are set up before module loading, which is critical for module-level AWS client instantiation. Combined with vi.resetModules for cold-start testing."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"We also run CDK assertion tests for all infrastructure. Template.fromStack with hasResourceProperties catches misconfigurations before deploy."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"CDK assertion tests are often underrated. They catch IAM policy misconfigurations, missing DLQs, and wrong Lambda configurations at synth time rather than after deployment. Much cheaper to fix."}]}'

# Session 5: Cost optimization
step "Session 5: AWS cost optimization"
create_session_with_messages "Cost optimization" \
  '{"role":"user","parts":[{"type":"text","content":"Our AWS bill increased 40% last month. I need to identify the cost drivers."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Start with AWS Cost Explorer grouped by service and usage type. Check for: idle NAT gateways (charged hourly), over-provisioned RDS instances, S3 storage class mismatches, and Lambda functions with excessive memory allocation."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"I found that Bedrock inference is our biggest cost driver. We are using Claude 3.5 Sonnet for every summarization call."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"For summarization tasks, consider Haiku instead of Sonnet — it is 10-15x cheaper and often sufficient quality for summarization and classification. Reserve Sonnet for complex reasoning tasks where quality difference matters."}]}' \
  '{"role":"user","parts":[{"type":"text","content":"Good idea. I switched to Haiku 4.5 for all summarization and classification. Our Bedrock cost dropped 80%. I always use cross-region inference profiles for model access."}]}' \
  '{"role":"assistant","parts":[{"type":"text","content":"Cross-region inference profiles are smart — they give you access to the latest models without hardcoding region-specific model IDs. The Haiku switch for routine tasks is a great cost optimization that maintains quality where it matters."}]}'

# ─── 4. Summary ──────────────────────────────────────────────────────

header "Seed Data Summary"

echo -e "${BOLD}  Resources:${NC}"
echo -e "    ${CYAN}Docs ingested:${NC}   ${GREEN}${DOCS_CREATED}${NC}"
echo -e "    ${CYAN}Namespaces:${NC}      ${GREEN}3${NC} (aws, typescript, architecture + runbooks)"
echo ""
echo -e "${BOLD}  Sessions:${NC}"
echo -e "    ${CYAN}Created:${NC}         ${GREEN}${SESSIONS_CREATED}${NC}"
echo -e "    ${CYAN}Messages sent:${NC}   ${GREEN}${MESSAGES_SENT}${NC}"
echo -e "    ${CYAN}Committed:${NC}       ${GREEN}${COMMITS_DONE}${NC}"
echo ""
echo -e "${BOLD}  Errors:${NC}          ${ERRORS}"
echo ""

if [[ "$ERRORS" -eq 0 ]]; then
  pass "Stress-test data seeded successfully."
  echo ""
  info "AgentCore will extract memories asynchronously from the ${SESSIONS_CREATED} sessions."
  info "Bridge Lambda will process them within ~30 seconds per session."
  info "Run 07-agentcore-memory.sh to verify the E2E chain."
else
  fail "Completed with ${ERRORS} errors — review output above."
fi
