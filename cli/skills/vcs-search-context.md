---
name: vcs-search-context
description: "Find, browse, and load VCS context using scan-decide-load"
compatibility: "VCS CLI configured via `vcs config init` or env vars VCS_API_URL + VCS_API_KEY"
---

# VCS Search Context

Retrieve context from Viking Context Service using a token-efficient scan-decide-load pattern. This skill covers five commands: `vcs find`, `vcs search`, `vcs read`, `vcs ls`, and `vcs tree`.

## When to Use

- You need background context before starting a task
- You want to find relevant documentation, memories, or skills
- You need to browse the namespace to understand what is stored
- You want to load specific content at the right detail level
- You are building a context window for an agent conversation
- After loading context, you may want to compile it into wiki pages — see `vcs-knowledge-ops` skill

## Alternative: MCP Gateway Access

These tools are also available as MCP tools via the VCS AgentCore Gateway. MCP-native clients (Claude.ai, Claude Code, Cursor) connect directly to the Gateway URL with OAuth 2.1 — no CLI installation needed. See the project README for client configuration.

## CLI vs MCP: When to Use Which

| Factor | CLI (`vcs`) | MCP Gateway |
|--------|------------|-------------|
| Setup | Install binary + `vcs config init` | OAuth 2.1 in client settings |
| Best for | Scripts, pipelines, non-MCP agents | Claude.ai, Claude Code, Cursor |
| Output control | `--json` flag, pipes, exit codes | Structured tool responses |
| Session tracking | Manual (`vcs session used`) | Automatic |
| Offline/CI | Works anywhere with API access | Requires MCP-capable client |

**Rule of thumb:** If your client supports MCP natively, use the Gateway. If you are scripting, in CI/CD, or your agent framework does not support MCP, use the CLI.

## Global Option

All VCS commands accept `--json` for machine-readable JSON output instead of human-readable text. Prefer `--json` when parsing output programmatically.

```bash
vcs find "query" --json
vcs read viking://resources/doc.md --json
```

## The Scan-Decide-Load Pattern

The core retrieval workflow for token-efficient context loading:

### Step 1: SCAN

Use `vcs find` or `vcs tree` to get a broad view of available content. This is cheap -- `vcs find` returns L0 abstracts (~100 tokens per result) and `vcs tree` shows structure without content.

```bash
# Semantic search for relevant resources
vcs find "authentication middleware patterns" --max-results 5

# Or browse namespace structure
vcs tree viking://resources/ --depth 2
```

### Step 2: DECIDE

Review the scored results or tree structure. Pick which URIs are relevant to your task. This is agent reasoning -- no CLI call needed.

Example output from `vcs find`:
```
0.87  viking://resources/docs/auth.md
      Authentication middleware setup and JWT validation patterns

0.72  viking://resources/docs/api-security.md
      API security best practices including rate limiting

0.45  viking://resources/docs/testing.md
      Test utilities and mock authentication helpers
```

Decision: Load `auth.md` (high relevance), skip `api-security.md` and `testing.md` (not needed for current task).

### Step 3: LOAD

Use `vcs read` to fetch full content only for selected resources. This is the expensive step -- only load what you actually need.

**Tip:** Use `--level 0` first to verify a resource exists and confirm its summary (~100 tokens) before committing to a full `--level 2` read:

```bash
# Quick verification before full load
vcs read viking://resources/docs/auth.md --level 0

# If the summary confirms relevance, load full content
vcs read viking://resources/docs/auth.md --level 2
```

### Complete Workflow Example

```bash
# 1. SCAN: find relevant resources (cheap, ~500 tokens total)
vcs find "database migration patterns" --max-results 5

# 2. DECIDE: review results, pick the best match (agent reasoning)

# 3. LOAD: fetch full content for selected resource (expensive, but targeted)
vcs read viking://resources/docs/migrations.md --level 2
```

### Session-Aware Variant

When working within a session, use `vcs search` for context-aware results:

```bash
# 1. SCAN: session-aware search (includes memories and skills)
SESSION="your-session-id"
vcs search "database migration patterns" --session "$SESSION"

# 2. DECIDE: review categorized results (resources, memories, skills)

# 3. LOAD: fetch selected resources
vcs read viking://resources/docs/migrations.md --level 2

# 4. RECORD: track what was loaded (improves future searches)
vcs session used "$SESSION" viking://resources/docs/migrations.md
```

## Command: `vcs find`

Stateless semantic search across all VCS content. Returns scored results with L0 abstracts.

### Basic Usage

```bash
vcs find <query> [options]
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<query>` | Yes | -- | Semantic search query |
| `--scope <uri>` | No | all | Limit search to URI scope |
| `--max-results <n>` | No | `5` | Maximum results (1-20) |
| `--min-score <n>` | No | `0.2` | Minimum score threshold (0-1) |

### Output Format

Human-readable output shows score, URI, and abstract per result:
```
{score}  {uri}
      {abstract}
```

Results are separated by blank lines. If no results match, prints "No results found." to stderr.

### When to Use

- One-shot searches without session context
- Quick lookups before starting work
- Scoped searches within a specific namespace

### Examples

```bash
# Basic search
vcs find "how to configure authentication"

# Scoped to a namespace
vcs find "error handling" --scope viking://resources/docs/

# More results with lower threshold
vcs find "deployment" --max-results 10 --min-score 0.1
```

## Command: `vcs search`

Session-aware semantic search. Uses conversation history for better relevance. Returns results categorized by type.

### Basic Usage

```bash
vcs search <query> --session <id>
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<query>` | Yes | -- | Semantic search query |
| `--session <id>` | **Yes** | -- | Session ID for context-aware search |

The `--session` flag is **required** -- `vcs search` always needs session context. For stateless search, use `vcs find` instead.

### Output Format

Results are grouped under category headers:
```
Resources:
0.87  viking://resources/docs/auth.md
      Authentication middleware setup

Memories:
0.72  viking://user/memories/preferences/2026-03-25t10-00-00z.md
      User prefers TypeScript for backend services

Skills:
0.65  viking://agent/skills/vcs-add-data.md
      How to ingest files and store memories
```

### When to Use

- Working within an active session
- Want results from memories and skills in addition to resources
- Want context-aware ranking based on conversation history

## Command: `vcs read`

Read content at a specified detail level. The loading step in scan-decide-load.

### Basic Usage

```bash
vcs read <uri> [--level <n>]
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<uri>` | Yes | -- | Resource URI to read |
| `--level <n>` | No | `2` | Detail level: 0 (summary ~100 tokens), 1 (outline), 2 (full content) |

### Output

Raw content written to stdout with no trailing newline. Pipes cleanly to other commands.

### Examples

```bash
vcs read viking://resources/docs/auth.md --level 0   # summary (~100 tokens)
vcs read viking://resources/docs/auth.md --level 1   # outline
vcs read viking://resources/docs/auth.md              # full content (default)
vcs read viking://resources/docs/auth.md | wc -w      # pipes cleanly
```

## Command: `vcs ls`

List children of a directory URI. Auto-paginates transparently. A trailing `/` is auto-appended if not present.

```bash
vcs ls <uri>
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<uri>` | Yes | -- | Directory URI to list |

Output shows URI, directory flag, context type, and timestamps. Prints "No items found." to stderr if empty.

```bash
vcs ls viking://resources/
vcs ls viking://user/memories/ --json
```

## Command: `vcs tree`

Show a recursive namespace tree with Unicode box-drawing. A trailing `/` is auto-appended if not present.

```bash
vcs tree <uri> [--depth <n>]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<uri>` | Yes | -- | Root URI to display tree from |
| `--depth <n>` | No | `3` | Maximum depth to traverse (min 1) |

```bash
vcs tree viking://resources/ --depth 2
```

## Decision Guide: `find` vs `search`

| Criterion | `vcs find` | `vcs search` |
|-----------|-----------|-------------|
| Session required | No | **Yes** |
| Result types | Resources only | Resources + Memories + Skills |
| Context-aware ranking | No | Yes (uses conversation history) |
| Best for | One-shot lookups, quick searches | Active sessions, comprehensive results |
| Stateless | Yes | No |

**Rule of thumb:** If you have a session ID, use `vcs search`. If you do not, use `vcs find`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "No results found" from `vcs find` | Query too specific or namespace empty | Broaden query; try `vcs tree viking://` to verify content exists |
| Timeout on `vcs read` | Large resource or slow API | Check `vcs health` first; try `--level 0` or `--level 1` for smaller payloads |
| "No items found" from `vcs ls` | Wrong URI or empty directory | Verify path with `vcs tree` at the parent level |
| Exit code 2 on any command | API unreachable | Run `vcs health`; check `VCS_API_URL` |

## Self-Ingestion

This skill file can be ingested into VCS for agent discovery:

```bash
vcs ingest cli/skills/vcs-search-context.md --prefix viking://agent/skills/
```

## Prerequisites

- VCS CLI installed and on PATH
- VCS configured via `vcs config init` or environment variables (`VCS_API_URL`, `VCS_API_KEY`)
- API reachable (verify with `vcs health`)
