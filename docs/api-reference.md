# REST API Reference

Base URL: `https://<api-id>.execute-api.<region>.amazonaws.com/v1`

All endpoints require an API key via `x-api-key` header.

## Ingestion

### POST /resources

Ingest a markdown document. Generates L0/L1/L2 summaries, embeddings, and triggers parent rollup.

**Request:**
```json
{
  "content_base64": "<base64-encoded markdown>",
  "uri_prefix": "viking://resources/blog/",
  "filename": "my-post.md",
  "instruction": "Focus on AWS services mentioned"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content_base64` | string | yes | Base64-encoded markdown content |
| `uri_prefix` | string | yes | Parent directory URI (must end with `/`) |
| `filename` | string | yes | Filename for the leaf URI |
| `instruction` | string | no | Custom summarisation guidance |

**Response (200):**
```json
{
  "status": "ok",
  "uri": "viking://resources/blog/my-post.md",
  "processing_status": "ready"
}
```

**Errors:**
- `409` — URI is currently being processed (another ingestion in flight)
- `400` — Invalid request (missing fields, bad URI format)

**Notes:**
- Synchronous — blocks until summarisation + embedding complete (~3-5 seconds)
- Idempotent — re-ingesting the same URI overwrites content in place
- Parent directory automatically gets a synthesised summary after ingestion

## Search

### POST /search/find

Stateless semantic search. Single query, no session context.

**Request:**
```json
{
  "query": "How does OAuth work?",
  "scope": "viking://resources/",
  "max_results": 5,
  "min_score": 0.4
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Natural language search query |
| `scope` | string | no | URI prefix to restrict search |
| `max_results` | number | no | Max results (default: 5) |
| `min_score` | number | no | Minimum relevance score (default: 0.4) |

**Response (200):**
```json
{
  "memories": [],
  "resources": [
    {
      "uri": "viking://resources/docs/auth/oauth.md",
      "level": 0,
      "score": 0.72,
      "abstract": "Guide to implementing OAuth 2.0..."
    }
  ],
  "skills": [],
  "trajectory": [
    {"step": 1, "action": "global_search", "candidates": 3},
    {"step": 2, "action": "drill", "uri": "viking://resources/docs/", "score": 0.68},
    {"step": 3, "action": "converged", "rounds": 2}
  ],
  "tokens_saved_estimate": 15200
}
```

### POST /search/search

Session-aware search with intent analysis. Decomposes queries using session context.

**Request:**
```json
{
  "query": "Help me with the config",
  "session_id": "sess_abc123",
  "max_results": 5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Natural language search query |
| `session_id` | string | yes | Active session ID for context |
| `max_results` | number | no | Max results per type (default: 5) |

**Response:** Same structure as `/search/find`, but with richer results from intent analysis.

**Chitchat detection:** If the query is a greeting or doesn't need retrieval:
```json
{
  "memories": [],
  "resources": [],
  "skills": [],
  "reason": "no_retrieval_needed",
  "tokens_saved_estimate": 0
}
```

## Filesystem

### GET /fs/ls

List children of a directory.

**Query params:**
- `uri` (required) — Directory URI to list
- `nextToken` (optional) — Pagination cursor

**Response:**
```json
{
  "items": [
    {
      "uri": "viking://resources/blog/my-post.md",
      "is_directory": false,
      "context_type": "resource",
      "created_at": "2026-03-20T04:30:55.665Z",
      "updated_at": "2026-03-20T04:30:55.665Z"
    }
  ],
  "nextToken": null
}
```

### GET /fs/tree

Recursive directory tree.

**Query params:**
- `uri` (optional) — Root URI (default: `viking://`)
- `depth` (optional) — Max depth (default: 3, max: 10)

### GET /fs/read

Read content at a specific level.

**Query params:**
- `uri` (required) — Resource URI
- `level` (required) — `0` (abstract ~100 tokens), `1` (overview ~2K tokens), `2` (full content)

**Response:**
```json
{
  "uri": "viking://resources/blog/my-post.md",
  "level": 0,
  "content": "Guide to deploying OpenViking on Lightsail...",
  "tokens": 87
}
```

### POST /fs/mkdir

Create a directory node.

**Request:**
```json
{
  "uri": "viking://resources/projects/vcs/"
}
```

### DELETE /fs/rm

Delete a node and all children (recursive cascade).

**Query params:**
- `uri` (required) — URI to delete

**Notes:**
- Deletes in order: S3 Vectors (index first) → DynamoDB → S3
- Rejects deletion when `processing_status=processing` (409)

### POST /fs/mv

Move/rename a node.

**Request:**
```json
{
  "from": "viking://resources/old-name/",
  "to": "viking://resources/new-name/"
}
```

**Notes:**
- Supports both files and directories
- Copy-update-delete protocol (idempotent, resumable)
- Re-uses existing embeddings (no Bedrock calls)
- Rejects move when source has `processing_status=processing`

## Sessions

### POST /sessions

Create a new session.

**Response:**
```json
{
  "session_id": "sess_abc123",
  "status": "active"
}
```

### POST /sessions/{id}/messages

Add a structured message to a session.

**Request:**
```json
{
  "role": "assistant",
  "parts": [
    {"type": "text", "content": "Here is how to configure embeddings..."},
    {"type": "context", "uri": "viking://resources/docs/config.md", "abstract": "Configuration reference..."},
    {"type": "tool", "name": "vcs_find", "input": {"query": "embedding config"}, "output": {"results": ["..."]}, "success": true}
  ]
}
```

### POST /sessions/{id}/used

Record context/skill usage for a turn.

**Request:**
```json
{
  "uris": ["viking://resources/docs/config.md"],
  "skill": {
    "uri": "viking://agent/skills/code-search",
    "input": "search config",
    "output": "found 3 matches",
    "success": true
  }
}
```

### POST /sessions/{id}/commit

Archive session and extract memories. Two-phase process:

1. **Archive** — messages + summary saved to S3, session L0/L1 written
2. **Extract** — memories extracted using 6-category taxonomy, deduplicated against existing

**Response:**
```json
{
  "status": "ok",
  "memories_created": 3,
  "memories_merged": 1,
  "memories_skipped": 2,
  "categories": {
    "preferences": 1,
    "entities": 2,
    "patterns": 1
  },
  "session_uri": "viking://session/sess_abc123/"
}
```

**Notes:**
- Idempotent — recommitting returns `already_committed` with no duplicate memories
- Memory categories: `profile`, `preferences`, `entities`, `events`, `cases`, `patterns`
- Confidence threshold: only memories with confidence >= 0.7 are stored
- Deduplication: cosine similarity >= 0.8 triggers LLM decision (skip/create/merge/delete)
