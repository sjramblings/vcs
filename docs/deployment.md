# Deployment Guide

## Prerequisites

- **Node.js 22+** — Lambda runtime
- **AWS CLI v2** — configured with a profile that has admin-level access
- **AWS CDK CLI** — `npm install -g aws-cdk`
- **just** (optional) — `brew install just` for task runner shortcuts

### AWS Account Requirements

- **Bedrock model access** — enable Claude Haiku 4.5 and Titan Embeddings V2 in your target region
- **CDK bootstrapped** — run `cdk bootstrap` once per account/region
- **Lambda concurrency** — default account quota is sufficient (no reserved concurrency used)

## First-Time Setup

```bash
# Clone and install
git clone https://github.com/sjramblings/vcs.git
cd vcs
npm install

# Configure AWS profile (edit justfile or use env vars)
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1  # or your preferred region

# Bootstrap CDK
just bootstrap
# or: npx cdk bootstrap --profile $AWS_PROFILE

# Deploy
just deploy
# or: npx cdk deploy --profile $AWS_PROFILE --require-approval broadening
```

## Stack Outputs

After deployment, the stack outputs:

| Output | Description |
|--------|-------------|
| `ApiLayerApiEndpoint` | REST API base URL |
| `ApiLayerApiKeyId` | API key ID (retrieve value with AWS CLI) |
| `McpGatewayUrl` | AgentCore Gateway MCP endpoint (OAuth-protected) |
| `McpGatewayId` | AgentCore Gateway ID |
| `DataLayerVectorSchemaValidation` | S3 Vectors schema audit (immutable after creation) |

### Retrieve API Key

```bash
API_KEY=$(aws apigateway get-api-key \
  --api-key <ApiKeyId from output> \
  --include-value \
  --query 'value' \
  --output text \
  --profile $AWS_PROFILE \
  --region $AWS_REGION)
```

## Configuration

All configuration is set at deploy time via CDK context in `cdk.json` and `lib/config.ts`.

### Key Configuration Values

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| Haiku model ID | `lib/config.ts` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock summarisation model |
| Titan model ID | `lib/config.ts` | `amazon.titan-embed-text-v2:0` | Embedding model |
| Vector dimensions | `lib/config.ts` | `1024` | Embedding vector size |
| Vector index name | `lib/config.ts` | `vcs-embeddings` | S3 Vectors index name |

### Environment Variables (Lambda)

Set automatically by CDK. Do not modify manually.

| Variable | Description |
|----------|-------------|
| `POWERTOOLS_SERVICE_NAME` | Lambda function identifier for logging/tracing |
| `POWERTOOLS_LOG_LEVEL` | Log level (default: INFO) |

### SSM Parameters

Cross-construct values stored in SSM under `/vcs/`:

| Parameter | Description |
|-----------|-------------|
| `/vcs/data/context-table-name` | DynamoDB context table |
| `/vcs/data/sessions-table-name` | DynamoDB sessions table |
| `/vcs/data/content-bucket-name` | S3 content bucket |
| `/vcs/data/vector-bucket-name` | S3 Vectors bucket |
| `/vcs/data/vector-index-name` | S3 Vectors index |
| `/vcs/compute/rollup-queue-url` | SQS FIFO queue URL |
| `/vcs/api/api-key-id` | API Gateway key ID |

## Infrastructure

### AWS Resources Created

| Resource | Type | Purpose |
|----------|------|---------|
| DynamoDB `vcs-context` | Table (on-demand) | Hierarchy, L0/L1 content |
| DynamoDB `vcs-sessions` | Table (on-demand) | Session state |
| S3 `vcs-content-*` | Bucket | L2 full content, archives |
| S3 Vectors `vcs-vectors-*` | Vector bucket | Embeddings (1024d cosine) |
| SQS `vcs-rollup-queue.fifo` | FIFO Queue | Parent rollup ordering |
| Lambda (7 functions) | Node.js 22 | Filesystem, ingestion, query, session, parent-summariser, memory bridge, MCP tool executor |
| API Gateway | REST API | All HTTP endpoints |
| AgentCore Gateway | MCP endpoint | OAuth 2.1 protected MCP server with 10 tools |
| Cognito User Pool | Auth | Auto-provisioned OAuth 2.1 authorization server |
| CloudWatch Dashboard | Dashboard | VCS-Operations (9 widgets) |
| CloudWatch Alarms (9) | Alarms | DLQ, errors, latency, cost |
| SNS Topic | Topic | Alarm notifications |

### IAM Permissions

Each Lambda has its own least-privilege role. Key permissions:

- **Bedrock**: `InvokeModel` on `foundation-model/*` and `inference-profile/*` (all regions for cross-region inference)
- **Marketplace**: `ViewSubscriptions`, `Subscribe` (required for Bedrock model access)
- **S3 Vectors**: `PutVectors`, `DeleteVectors`, `QueryVectors`, `GetVectors`
- **DynamoDB**: Scoped to specific tables
- **SSM**: Read-only, scoped to `/vcs/*`

## Updating

```bash
# Pull latest changes
git pull

# Deploy updates
just deploy
```

CDK handles incremental updates — only changed resources are modified.

## Destroying

```bash
just destroy VcsStack
# or: npx cdk destroy VcsStack --profile $AWS_PROFILE --force
```

This removes all AWS resources. DynamoDB tables and S3 buckets with data will require manual cleanup if they contain data (CDK's removal policy is set to DESTROY for POC).

## Monitoring

### CloudWatch Dashboard

Navigate to CloudWatch > Dashboards > `VCS-Operations` in your region.

Widgets include:
- Lambda invocations and errors per function
- Ingestion and retrieval P50/P99 latency
- Bedrock token usage
- DynamoDB consumed capacity
- SQS queue depth and DLQ messages

### Alarm Notifications

Subscribe your email to the `vcs-alarms` SNS topic:

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:<region>:<account>:vcs-alarms \
  --protocol email \
  --notification-endpoint your@email.com \
  --profile $AWS_PROFILE \
  --region $AWS_REGION
```

### Troubleshooting

```bash
# Check recent Lambda errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/VcsStack-ComputeLayer* \
  --filter-pattern "ERROR" \
  --start-time $(date -v-1H +%s)000 \
  --profile $AWS_PROFILE \
  --region $AWS_REGION

# Check DLQ for failed rollup messages
aws sqs get-queue-attributes \
  --queue-url <dlq-url> \
  --attribute-names ApproximateNumberOfMessages \
  --profile $AWS_PROFILE \
  --region $AWS_REGION
```
