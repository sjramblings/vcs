#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ─────────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 [--profile <aws-profile>] [--region <aws-region>]"
  echo ""
  echo "Options:"
  echo "  --profile   AWS CLI profile to use for authentication"
  echo "  --region    AWS region (default: us-east-1)"
  echo ""
  echo "Environment variable overrides:"
  echo "  AWS_PROFILE          Same as --profile"
  echo "  AWS_REGION           Same as --region"
  echo "  VCS_CONTEXT_TABLE    DynamoDB context table (default: vcs-context)"
  echo "  VCS_SESSIONS_TABLE   DynamoDB sessions table (default: vcs-sessions)"
  echo "  VCS_CONTENT_BUCKET   S3 content bucket (auto-resolved from SSM)"
  echo "  VCS_VECTOR_BUCKET    S3 vector bucket (auto-resolved from SSM)"
  echo "  VCS_VECTOR_INDEX     S3 vector index (auto-resolved from SSM)"
  exit 1
}

# ─── Parse arguments ───────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)  AWS_PROFILE="$2"; shift 2 ;;
    --region)   AWS_REGION="$2"; shift 2 ;;
    --help|-h)  usage ;;
    *)          echo "Unknown option: $1"; usage ;;
  esac
done

# ─── Configuration ─────────────────────────────────────────────────
CONTEXT_TABLE="${VCS_CONTEXT_TABLE:-vcs-context}"
SESSIONS_TABLE="${VCS_SESSIONS_TABLE:-vcs-sessions}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Build common AWS CLI args (profile + region)
AWS_ARGS=(--region "$AWS_REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_ARGS+=(--profile "$AWS_PROFILE")
fi

# Resolve content bucket name from SSM (or override via env)
if [[ -z "${VCS_CONTENT_BUCKET:-}" ]]; then
  VCS_CONTENT_BUCKET=$(aws ssm get-parameter \
    --name "/vcs/data/content-bucket-name" \
    --query "Parameter.Value" --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo "")
fi

# Resolve vector bucket name from SSM (or override via env)
if [[ -z "${VCS_VECTOR_BUCKET:-}" ]]; then
  VCS_VECTOR_BUCKET=$(aws ssm get-parameter \
    --name "/vcs/data/vector-bucket-name" \
    --query "Parameter.Value" --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo "")
fi

# Resolve vector index name from SSM (or override via env)
if [[ -z "${VCS_VECTOR_INDEX:-}" ]]; then
  VCS_VECTOR_INDEX=$(aws ssm get-parameter \
    --name "/vcs/data/vector-index-name" \
    --query "Parameter.Value" --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo "")
fi

# Colours
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

header() { echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════${NC}"; echo -e "${BOLD}${BLUE}  $1${NC}"; echo -e "${BOLD}${BLUE}═══════════════════════════════════════${NC}\n"; }

header "VCS Purge — Delete All Data"

if [[ -n "${AWS_PROFILE:-}" ]]; then
  echo -e "${YELLOW}AWS Profile: ${BOLD}${AWS_PROFILE}${NC}"
fi
echo -e "${YELLOW}AWS Region:  ${AWS_REGION}${NC}"
echo ""
echo -e "${YELLOW}This will permanently delete ALL data from:${NC}"
echo -e "${YELLOW}  • DynamoDB table:  ${CONTEXT_TABLE}${NC}"
echo -e "${YELLOW}  • DynamoDB table:  ${SESSIONS_TABLE}${NC}"
echo -e "${YELLOW}  • S3 bucket:       ${VCS_CONTENT_BUCKET:-<not found>}${NC}"
echo -e "${YELLOW}  • S3 Vectors:      ${VCS_VECTOR_BUCKET:-<not found>} / ${VCS_VECTOR_INDEX:-<not found>}${NC}"
echo ""
echo -e "${RED}${BOLD}  ⚠  THIS CANNOT BE UNDONE  ⚠${NC}"
echo ""

read -r -p "Type 'PURGE' to confirm: " CONFIRM

if [[ "$CONFIRM" != "PURGE" ]]; then
  echo -e "${YELLOW}Aborted. No data was deleted.${NC}"
  exit 0
fi

echo ""

# ─── 1. Purge DynamoDB: vcs-context ──────────────────────────────────

header "1. Purging DynamoDB: ${CONTEXT_TABLE}"

CONTEXT_DELETED=0
SCAN_TOKEN=""

while true; do
  if [[ -z "$SCAN_TOKEN" ]]; then
    SCAN_RESULT=$(aws dynamodb scan \
      --table-name "$CONTEXT_TABLE" \
      --projection-expression "uri, #lvl" \
      --expression-attribute-names '{"#lvl": "level"}' \
      "${AWS_ARGS[@]}" \
      --output json 2>/dev/null)
  else
    SCAN_RESULT=$(aws dynamodb scan \
      --table-name "$CONTEXT_TABLE" \
      --projection-expression "uri, #lvl" \
      --expression-attribute-names '{"#lvl": "level"}' \
      --exclusive-start-key "$SCAN_TOKEN" \
      "${AWS_ARGS[@]}" \
      --output json 2>/dev/null)
  fi

  ITEM_COUNT=$(echo "$SCAN_RESULT" | jq '.Items | length')

  if [[ "$ITEM_COUNT" -eq 0 ]]; then
    break
  fi

  # Build batch delete requests (max 25 per batch)
  ITEMS=$(echo "$SCAN_RESULT" | jq -c '.Items[]')
  BATCH=()
  BATCH_COUNT=0

  while IFS= read -r ITEM; do
    URI=$(echo "$ITEM" | jq -r '.uri.S')
    LEVEL=$(echo "$ITEM" | jq -r '.level.N')
    BATCH+=("{\"DeleteRequest\":{\"Key\":{\"uri\":{\"S\":\"${URI}\"},\"level\":{\"N\":\"${LEVEL}\"}}}}")
    BATCH_COUNT=$(( BATCH_COUNT + 1 ))

    if [[ "$BATCH_COUNT" -ge 25 ]]; then
      BATCH_JSON=$(printf '%s,' "${BATCH[@]}" | sed 's/,$//')
      aws dynamodb batch-write-item \
        --request-items "{\"${CONTEXT_TABLE}\":[${BATCH_JSON}]}" \
        "${AWS_ARGS[@]}" > /dev/null 2>&1
      CONTEXT_DELETED=$(( CONTEXT_DELETED + BATCH_COUNT ))
      echo -e "${GREEN}  ✓ Deleted batch of ${BATCH_COUNT} items${NC}"
      BATCH=()
      BATCH_COUNT=0
    fi
  done <<< "$ITEMS"

  # Flush remaining
  if [[ "$BATCH_COUNT" -gt 0 ]]; then
    BATCH_JSON=$(printf '%s,' "${BATCH[@]}" | sed 's/,$//')
    aws dynamodb batch-write-item \
      --request-items "{\"${CONTEXT_TABLE}\":[${BATCH_JSON}]}" \
      "${AWS_ARGS[@]}" > /dev/null 2>&1
    CONTEXT_DELETED=$(( CONTEXT_DELETED + BATCH_COUNT ))
    echo -e "${GREEN}  ✓ Deleted batch of ${BATCH_COUNT} items${NC}"
  fi

  # Check for pagination
  SCAN_TOKEN=$(echo "$SCAN_RESULT" | jq -r '.LastEvaluatedKey // empty')
  if [[ -z "$SCAN_TOKEN" ]]; then
    break
  fi
done

echo -e "${GREEN}  ${CONTEXT_DELETED} items deleted from ${CONTEXT_TABLE}${NC}"

# ─── 2. Purge DynamoDB: vcs-sessions ─────────────────────────────────

header "2. Purging DynamoDB: ${SESSIONS_TABLE}"

SESSIONS_DELETED=0
SCAN_TOKEN=""

while true; do
  if [[ -z "$SCAN_TOKEN" ]]; then
    SCAN_RESULT=$(aws dynamodb scan \
      --table-name "$SESSIONS_TABLE" \
      --projection-expression "session_id, entry_type_seq" \
      "${AWS_ARGS[@]}" \
      --output json 2>/dev/null)
  else
    SCAN_RESULT=$(aws dynamodb scan \
      --table-name "$SESSIONS_TABLE" \
      --projection-expression "session_id, entry_type_seq" \
      --exclusive-start-key "$SCAN_TOKEN" \
      "${AWS_ARGS[@]}" \
      --output json 2>/dev/null)
  fi

  ITEM_COUNT=$(echo "$SCAN_RESULT" | jq '.Items | length')

  if [[ "$ITEM_COUNT" -eq 0 ]]; then
    break
  fi

  ITEMS=$(echo "$SCAN_RESULT" | jq -c '.Items[]')
  BATCH=()
  BATCH_COUNT=0

  while IFS= read -r ITEM; do
    SID=$(echo "$ITEM" | jq -r '.session_id.S')
    ETS=$(echo "$ITEM" | jq -r '.entry_type_seq.S')
    BATCH+=("{\"DeleteRequest\":{\"Key\":{\"session_id\":{\"S\":\"${SID}\"},\"entry_type_seq\":{\"S\":\"${ETS}\"}}}}")
    BATCH_COUNT=$(( BATCH_COUNT + 1 ))

    if [[ "$BATCH_COUNT" -ge 25 ]]; then
      BATCH_JSON=$(printf '%s,' "${BATCH[@]}" | sed 's/,$//')
      aws dynamodb batch-write-item \
        --request-items "{\"${SESSIONS_TABLE}\":[${BATCH_JSON}]}" \
        "${AWS_ARGS[@]}" > /dev/null 2>&1
      SESSIONS_DELETED=$(( SESSIONS_DELETED + BATCH_COUNT ))
      echo -e "${GREEN}  ✓ Deleted batch of ${BATCH_COUNT} items${NC}"
      BATCH=()
      BATCH_COUNT=0
    fi
  done <<< "$ITEMS"

  if [[ "$BATCH_COUNT" -gt 0 ]]; then
    BATCH_JSON=$(printf '%s,' "${BATCH[@]}" | sed 's/,$//')
    aws dynamodb batch-write-item \
      --request-items "{\"${SESSIONS_TABLE}\":[${BATCH_JSON}]}" \
      "${AWS_ARGS[@]}" > /dev/null 2>&1
    SESSIONS_DELETED=$(( SESSIONS_DELETED + BATCH_COUNT ))
    echo -e "${GREEN}  ✓ Deleted batch of ${BATCH_COUNT} items${NC}"
  fi

  SCAN_TOKEN=$(echo "$SCAN_RESULT" | jq -r '.LastEvaluatedKey // empty')
  if [[ -z "$SCAN_TOKEN" ]]; then
    break
  fi
done

echo -e "${GREEN}  ${SESSIONS_DELETED} items deleted from ${SESSIONS_TABLE}${NC}"

# ─── 3. Purge S3: content bucket ─────────────────────────────────────

header "3. Purging S3: ${VCS_CONTENT_BUCKET:-<skipped>}"

S3_DELETED=0

if [[ -n "${VCS_CONTENT_BUCKET:-}" ]]; then
  # List and delete all objects (handles pagination automatically)
  OBJECTS=$(aws s3api list-objects-v2 \
    --bucket "$VCS_CONTENT_BUCKET" \
    --query "Contents[].Key" \
    --output json \
    "${AWS_ARGS[@]}" 2>/dev/null || echo "null")

  if [[ "$OBJECTS" != "null" && "$OBJECTS" != "[]" ]]; then
    S3_DELETED=$(echo "$OBJECTS" | jq 'length')
    # Build delete payload
    DELETE_JSON=$(echo "$OBJECTS" | jq '{Objects: [.[] | {Key: .}], Quiet: true}')
    aws s3api delete-objects \
      --bucket "$VCS_CONTENT_BUCKET" \
      --delete "$DELETE_JSON" \
      "${AWS_ARGS[@]}" > /dev/null 2>&1
    echo -e "${GREEN}  ✓ Deleted ${S3_DELETED} objects${NC}"
  else
    echo -e "${YELLOW}  Bucket empty — nothing to delete${NC}"
  fi
else
  echo -e "${YELLOW}  Skipped — bucket name not resolved${NC}"
fi

# ─── 4. Purge S3 Vectors ─────────────────────────────────────────────

header "4. Purging S3 Vectors: ${VCS_VECTOR_BUCKET:-<skipped>} / ${VCS_VECTOR_INDEX:-<skipped>}"

VECTORS_DELETED=0

if [[ -n "${VCS_VECTOR_BUCKET:-}" && -n "${VCS_VECTOR_INDEX:-}" ]]; then
  echo -e "${CYAN}  ▸ Listing all vectors ...${NC}"

  NEXT_TOKEN=""
  while true; do
    LIST_ARGS=(--vector-bucket-name "$VCS_VECTOR_BUCKET" --index-name "$VCS_VECTOR_INDEX" "${AWS_ARGS[@]}" --output json)
    if [[ -n "$NEXT_TOKEN" ]]; then
      LIST_ARGS+=(--next-token "$NEXT_TOKEN")
    fi

    LIST_RESULT=$(aws s3vectors list-vectors "${LIST_ARGS[@]}" 2>/dev/null || echo '{"vectors":[]}')
    KEYS=$(echo "$LIST_RESULT" | jq -r '.vectors[].key // empty' 2>/dev/null)

    if [[ -z "$KEYS" ]]; then
      break
    fi

    # Collect keys into batches of 25 for deletion
    BATCH_KEYS=()
    while IFS= read -r KEY; do
      BATCH_KEYS+=("$KEY")

      if [[ "${#BATCH_KEYS[@]}" -ge 25 ]]; then
        KEYS_JSON=$(printf '%s\n' "${BATCH_KEYS[@]}" | jq -R . | jq -s .)
        aws s3vectors delete-vectors \
          --vector-bucket-name "$VCS_VECTOR_BUCKET" \
          --index-name "$VCS_VECTOR_INDEX" \
          --keys "$KEYS_JSON" \
          "${AWS_ARGS[@]}" > /dev/null 2>&1
        VECTORS_DELETED=$(( VECTORS_DELETED + ${#BATCH_KEYS[@]} ))
        echo -e "${GREEN}  ✓ Deleted batch of ${#BATCH_KEYS[@]} vectors${NC}"
        BATCH_KEYS=()
      fi
    done <<< "$KEYS"

    # Flush remaining
    if [[ "${#BATCH_KEYS[@]}" -gt 0 ]]; then
      KEYS_JSON=$(printf '%s\n' "${BATCH_KEYS[@]}" | jq -R . | jq -s .)
      aws s3vectors delete-vectors \
        --vector-bucket-name "$VCS_VECTOR_BUCKET" \
        --index-name "$VCS_VECTOR_INDEX" \
        --keys "$KEYS_JSON" \
        "${AWS_ARGS[@]}" > /dev/null 2>&1
      VECTORS_DELETED=$(( VECTORS_DELETED + ${#BATCH_KEYS[@]} ))
      echo -e "${GREEN}  ✓ Deleted batch of ${#BATCH_KEYS[@]} vectors${NC}"
    fi

    NEXT_TOKEN=$(echo "$LIST_RESULT" | jq -r '.nextToken // empty' 2>/dev/null)
    if [[ -z "$NEXT_TOKEN" ]]; then
      break
    fi
  done

  echo -e "${GREEN}  ${VECTORS_DELETED} vectors deleted${NC}"
else
  echo -e "${YELLOW}  Skipped — vector bucket/index not resolved${NC}"
fi

# ─── Summary ──────────────────────────────────────────────────────────

echo ""
header "Purge Complete"

TOTAL=$(( CONTEXT_DELETED + SESSIONS_DELETED + S3_DELETED + VECTORS_DELETED ))
echo -e "${BOLD}  ${CONTEXT_TABLE}:    ${GREEN}${CONTEXT_DELETED} items deleted${NC}"
echo -e "${BOLD}  ${SESSIONS_TABLE}:  ${GREEN}${SESSIONS_DELETED} items deleted${NC}"
echo -e "${BOLD}  S3 content:       ${GREEN}${S3_DELETED} objects deleted${NC}"
echo -e "${BOLD}  S3 vectors:       ${GREEN}${VECTORS_DELETED} vectors deleted${NC}"
echo ""
echo -e "${BOLD}  Total: ${GREEN}${TOTAL} items purged${NC}"
echo ""
echo -e "${GREEN}✓ VCS is now in a fresh state. Re-run showcase scripts to repopulate.${NC}"
