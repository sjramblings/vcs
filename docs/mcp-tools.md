# MCP Tool Reference

VCS exposes 10 MCP tools via an AgentCore Gateway with OAuth 2.1 authentication. Any MCP-compatible client (Claude.ai, Claude Code, Cursor, custom agents) can connect using standard OAuth flows.

## Connection

**Endpoint:** AgentCore Gateway URL (from stack output `McpGatewayUrl`)

```
https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp
```

OAuth discovery is automatic via RFC 9728 — clients discover the authorization server from the Gateway URL.

### Authentication Setup

After deploying the stack, the Gateway auto-provisions a Cognito User Pool with OAuth 2.1. To authenticate:

#### 1. Discover Cognito Details

```bash
# Get Gateway ID from CDK output
GATEWAY_ID=$(aws cloudformation describe-stacks \
  --stack-name VcsStack \
  --query 'Stacks[0].Outputs[?OutputKey==`McpGatewayId`].OutputValue' \
  --output text --profile $AWS_PROFILE --region $AWS_REGION)

# Get the auto-provisioned Cognito User Pool and Client from Gateway resources
aws cloudformation list-stack-resources \
  --stack-name VcsStack \
  --query 'StackResourceSummaries[?ResourceType==`AWS::Cognito::UserPool`]' \
  --profile $AWS_PROFILE --region $AWS_REGION

aws cloudformation list-stack-resources \
  --stack-name VcsStack \
  --query 'StackResourceSummaries[?ResourceType==`AWS::Cognito::UserPoolClient`]' \
  --profile $AWS_PROFILE --region $AWS_REGION
```

#### 2. Get Client Credentials

```bash
# Get the client ID and secret for the auto-provisioned app client
USER_POOL_ID=<from step 1>
CLIENT_ID=$(aws cognito-idp list-user-pool-clients \
  --user-pool-id $USER_POOL_ID \
  --query 'UserPoolClients[0].ClientId' \
  --output text --profile $AWS_PROFILE --region $AWS_REGION)

aws cognito-idp describe-user-pool-client \
  --user-pool-id $USER_POOL_ID \
  --client-id $CLIENT_ID \
  --profile $AWS_PROFILE --region $AWS_REGION
```

#### 3. Get OAuth Token (client_credentials flow)

```bash
# Get the Cognito domain
COGNITO_DOMAIN=$(aws cognito-idp describe-user-pool \
  --user-pool-id $USER_POOL_ID \
  --query 'UserPool.Domain' \
  --output text --profile $AWS_PROFILE --region $AWS_REGION)

# Acquire token
TOKEN=$(curl -s -X POST "https://${COGNITO_DOMAIN}.auth.${AWS_REGION}.amazoncognito.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -d "grant_type=client_credentials&scope=<resource-server-scopes>" \
  | jq -r '.access_token')
```

#### 4. Create a User (Optional — for browser-based PKCE flows)

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username your@email.com \
  --temporary-password "TempPass123!" \
  --profile $AWS_PROFILE --region $AWS_REGION

# Set permanent password
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username your@email.com \
  --password "YourPassword123!" \
  --permanent \
  --profile $AWS_PROFILE --region $AWS_REGION
```

### Client Configuration

#### Claude Code

Add to `.mcp.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "vcs": {
      "type": "http",
      "url": "https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp"
    }
  }
}
```

Claude Code discovers OAuth automatically via RFC 9728. On first use, it opens a browser for Cognito login.

#### Claude.ai

1. Go to **Settings > Connectors > Add Custom Connector**
2. Enter the Gateway URL
3. Claude.ai discovers OAuth endpoints automatically
4. Click **Connect** — browser redirects to Cognito login

#### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vcs": {
      "url": "https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### Verification

Run the included verification script to test all tools:

```bash
GATEWAY_URL="<McpGatewayUrl from CDK output>" \
COGNITO_CLIENT_ID="<client-id>" \
COGNITO_CLIENT_SECRET="<client-secret>" \
COGNITO_DOMAIN="<cognito-domain>" \
COGNITO_SCOPES="<resource-server-scopes>" \
./scripts/verify-gateway.sh
```

## Tools

### vcs_find

Stateless semantic search. Best for simple queries without session context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural language search query |
| `scope` | string | no | URI prefix to restrict search (e.g. `viking://resources/`) |
| `max_results` | number | no | Maximum results (default: 5) |

**Example:** "Find documents about authentication patterns"

**Returns:** Ranked results with URI, score, and L0 abstract for each match.

### vcs_search

Session-aware search with intent analysis. Uses session context to decompose queries into typed sub-queries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural language search query |
| `session_id` | string | yes | Current session ID |
| `max_results` | number | no | Maximum results per type (default: 5) |

**Example:** "Help me create an RFC document" (with session context about current project)

**Returns:** Results grouped by type (memories, resources, skills) with retrieval trajectory.

### vcs_read

Read content at a specific resolution level.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | `viking://` URI to read |
| `level` | number | no | 0=abstract (~100 tokens), 1=overview (~2K), 2=full (default: 0) |

**Usage pattern:**
1. Search returns L0 abstracts
2. Read interesting results at level 1 for more detail
3. Load level 2 only when you need the full document

### vcs_ls

List children of a directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Directory URI to list |

**Example:** `vcs_ls({ uri: "viking://resources/" })`

### vcs_tree

Show recursive directory tree structure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | no | Root URI (defaults to `viking://`) |
| `depth` | number | no | Maximum depth (default: 3, max: 10) |

### vcs_ingest

Ingest a markdown document into the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri_prefix` | string | yes | Parent directory URI ending with `/` |
| `filename` | string | yes | Filename for the document |
| `content` | string | yes | Markdown content |
| `instruction` | string | no | Custom summarisation guidance |

**Example:** `vcs_ingest({ uri_prefix: "viking://resources/notes/", filename: "meeting.md", content: "# Meeting Notes\n..." })`

### vcs_create_session

Create a new VCS session for tracking conversations. Returns a session ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | No parameters required |

**Returns:** `{ session_id: "..." }`

### vcs_add_message

Record a conversation message in a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Session ID |
| `role` | string | yes | `user`, `assistant`, `system`, or `tool` |
| `content` | string | yes | Message text |

### vcs_used

Track which URIs/skills were consulted during a turn.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Session ID |
| `uris` | string[] | yes | URIs that were read |
| `skill` | string | no | Skill name that was applied |

### vcs_commit_session

Archive session and extract memories at conversation end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Session ID to commit |

**What happens:**
1. Messages archived to S3
2. Session summary generated (one-liner, key concepts)
3. Session L0/L1 written (searchable in future)
4. Memories extracted using 6-category taxonomy
5. Each memory deduplicated against existing knowledge
6. New/merged memories stored with embeddings

## Recommended Agent Workflow

```
Session Start:
  → vcs_create_session (returns session_id)

Each Turn:
  1. vcs_search (or vcs_find for simple queries)
  2. vcs_read level=0 for abstracts
  3. vcs_read level=2 for documents you need
  4. [Do your work]
  5. vcs_add_message (record what happened)
  6. vcs_used (record which URIs you consulted)

Session End:
  → vcs_commit_session (extract memories)
```

## Token Efficiency

| Approach | Tokens per query |
|----------|-----------------|
| Traditional RAG (load all chunks) | 10,000-20,000 |
| VCS scan (L0 abstracts only) | 500-1,000 |
| VCS scan + selective L2 load | 2,000-4,000 |
| **Savings** | **75-85%** |
