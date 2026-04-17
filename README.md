# Viking Context Service

AWS-native hierarchical context database for AI agents. Implements OpenViking's L0/L1/L2 tiered summarisation patterns on DynamoDB + S3 + S3 Vectors + Bedrock + Lambda.

## What is this?

A context database that gives AI agents a persistent, structured brain instead of flat text chunks. Agents scan L0 abstracts (~100 tokens each) to find relevant context, then load full L2 content only when needed — achieving 75-85% token reduction compared to traditional RAG.

Built on **AWS primitives only**: DynamoDB single-table, S3 content bucket, S3 Vectors ANN index, SQS FIFO rollup queue, API Gateway REST + API key, and four Lambdas. One `cdk deploy` brings up the whole thing.

Inspired by [OpenViking](https://github.com/ArcAI-NexGen/OpenViking) (ByteDance); see `ANALYSIS.md` for the design thesis and `docs/architecture.md` for the system walkthrough.

## Architecture at a glance

```
ingestion ─▶ DynamoDB (L0/L1) ─┐
          └▶ S3 (L2)           ├─▶ parent-summariser ─▶ rollup ─▶ drill-down retrieval
          └▶ S3 Vectors        ┘       (SQS FIFO)            (query Lambda)
```

Four required Lambdas in the default deploy: `ingestion`, `parent-summariser`, `filesystem`, `query`. Two optional: `session` (session archival) and `mcp-tools` (behind `useAgentCoreGateway` context flag).

## Quick start

### Prerequisites
- Node.js 22+
- AWS CLI v2
- AWS CDK v2 (`npm install -g aws-cdk`)
- Bedrock model access: `amazon.nova-micro-v1:0`, `amazon.nova-lite-v1:0`, `amazon.titan-embed-text-v2:0`

### Deploy

```bash
npm install
npx cdk bootstrap           # first time only
npx cdk deploy VcsStack
```

After deploy, capture the outputs:

```
VcsStack.ApiLayerApiEndpoint = https://<api-id>.execute-api.<region>.amazonaws.com/v1/
VcsStack.ApiLayerApiKeyId    = <key-id>
```

Fetch the API key value:

```bash
aws apigateway get-api-key --api-key <key-id> --include-value --query 'value' --output text
```

### Ingest a document

```bash
export VCS_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/v1/"
export VCS_API_KEY="<api-key-value>"

curl -X POST "$VCS_API_URL/resources" \
  -H "x-api-key: $VCS_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "uri_prefix": "viking://resources/docs/",
    "filename": "hello.md",
    "content_base64": "'"$(echo '# Hello\n\nFirst document.' | base64)"'"
  }'
```

### Read and search

```bash
# Read at level 0 (abstract), 1 (sections), or 2 (full)
curl -H "x-api-key: $VCS_API_KEY" \
  "$VCS_API_URL/fs/read?uri=viking://resources/docs/hello.md&level=0"

# Semantic search
curl -X POST "$VCS_API_URL/search/find" \
  -H "x-api-key: $VCS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"query": "greetings", "max_results": 5, "min_score": 0}'
```

## Optional features

| Feature | How to enable |
|---|---|
| **AgentCore Gateway (managed MCP + OAuth)** | `npx cdk deploy VcsStack -c useAgentCoreGateway=true` |
| **Evaluation harness** (CodeBuild + Synthetics canaries) | `npx cdk deploy --app 'npx ts-node bin/vcs-eval.ts' VcsEvalStack` |

Both are off by default so the customer stack stays minimal.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit over bin/ lib/ src/
npm test             # unit tests (vitest)
npm run synth        # cdk synth VcsStack
```

### End-to-end smoke test

Requires a deployed stack and its outputs:

```bash
export VCS_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/v1/"
export VCS_API_KEY="<api-key-value>"
npm run test:e2e
```

The smoke test ingests a doc, waits for parent rollup, reads L0/L1/L2, and verifies the document appears in a `find` query. This is the single gate between `main` and the `v1.0.0-stable` tag.

## Cost

Target: **$10–18 / month** at POC scale (idle + light use). Primary cost drivers are Bedrock invocations on ingest and rollup; both are metered by CloudWatch alarms on `BedrockEstimatedCostUSD` and `ParentRollupLatency`.

## License

ISC
