---
name: vcs-manage
description: "Sessions, namespace ops, health checks, and CLI config"
compatibility: "VCS CLI configured via `vcs config init` or env vars VCS_API_URL + VCS_API_KEY"
---

# VCS Manage

Manage VCS sessions, organize the namespace, check connectivity, and configure the CLI.

Covers: session lifecycle (create, message, used, commit, delete), namespace operations (mkdir, rm, mv), health and status checks, and configuration setup.

## When to Use

- Starting a new agent conversation that should be tracked (session create)
- Recording messages and context usage during a conversation (session message, used)
- Ending a conversation to trigger memory extraction (session commit)
- Cleaning up sessions no longer needed (session delete)
- Creating directory structure in the namespace (mkdir)
- Removing resources or directories (rm)
- Moving or renaming resources (mv)
- Checking if VCS is reachable (health)
- Getting an overview of the VCS instance (status)
- Setting up CLI configuration for the first time (config init)
- After session commit, run wiki health check — see `vcs-knowledge-ops` skill

## Alternative: MCP Gateway Access

These tools are also available as MCP tools via the VCS AgentCore Gateway. MCP-native clients (Claude.ai, Claude Code, Cursor) connect directly to the Gateway URL with OAuth 2.1 — no CLI installation needed. See the project README for client configuration.

## Global Option

All commands accept `--json` for machine-readable JSON output instead of human-readable text. Recommended for scripting and agent use.

```bash
vcs health --json
vcs session create --json
```

## Setup

Run once to configure the CLI. Configuration is required before any other command works.

### Config Resolution Order

1. Environment variables: `VCS_API_URL` and `VCS_API_KEY` (checked first)
2. Config file: `~/.vcs/config.json` (fallback)

### `vcs config init`

Initialize configuration. In non-TTY (agent) mode, both flags are required.

```bash
vcs config init --url https://your-api.execute-api.us-east-1.amazonaws.com/prod/ --key your-api-key
```

| Flag | Required | Description |
|------|----------|-------------|
| `--url <url>` | Yes (non-TTY) | VCS API URL |
| `--key <key>` | Yes (non-TTY) | VCS API key |

Validates connectivity before saving. Saves to `~/.vcs/config.json` even if connectivity check fails (with warning).

### `vcs config show`

Display resolved configuration with masked API key.

```bash
vcs config show
```

Output shows: `api_url`, `api_key` (masked), `source` (env or file), `config_file` path.

## Session Lifecycle

Sessions track agent conversations and trigger memory extraction on commit.

### Complete Workflow

```bash
# 1. Create session and capture the bare session ID
SESSION=$(vcs session create)

# 2. Record conversation messages
vcs session message "$SESSION" user "How do I set up authentication?"
vcs session message "$SESSION" assistant "Here is how to configure auth..."

# 3. Record which resources were consulted
vcs session used "$SESSION" viking://resources/docs/auth.md viking://resources/docs/jwt.md

# 4. Commit session (triggers memory extraction, 60s timeout)
vcs session commit "$SESSION"
```

### Quick Patterns

Most session workflows follow one of these shorthand patterns:

```bash
# Minimal session (just trigger memory extraction on commit)
SESSION=$(vcs session create) && vcs session commit "$SESSION"

# Record-and-commit (typical agent conversation)
S=$(vcs session create)
vcs session message "$S" user "How do I deploy to prod?"
vcs session message "$S" assistant "Run the deploy pipeline..."
vcs session commit "$S"

# Full tracking (record messages + context usage)
S=$(vcs session create)
vcs session message "$S" user "Explain auth setup"
vcs session used "$S" viking://resources/docs/auth.md
vcs session message "$S" assistant "Based on the docs, auth uses JWT..."
vcs session commit "$S"
```

### `vcs session create`

Create a new session. No arguments. Prints bare session ID to stdout.

```bash
SESSION=$(vcs session create)
echo "$SESSION"  # e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### `vcs session message <id> <role> <content>`

Add a message to a session.

```bash
vcs session message "$SESSION" user "What patterns exist for error handling?"
vcs session message "$SESSION" assistant "The codebase uses CliError for typed errors..."
vcs session message "$SESSION" system "You are a helpful coding assistant."
vcs session message "$SESSION" tool "Function returned: { status: 'ok' }"
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<id>` | Yes | Session ID |
| `<role>` | Yes | One of: `user`, `assistant`, `system`, `tool` |
| `<content>` | Yes | Message text |

### `vcs session used <id> <uri...>`

Record one or more URIs as context used during the session. Variadic -- accepts multiple URIs.

```bash
vcs session used "$SESSION" viking://resources/docs/auth.md
vcs session used "$SESSION" viking://resources/docs/api.md viking://user/memories/preferences/2026-03-26.md
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<id>` | Yes | Session ID |
| `<uri...>` | Yes | One or more URIs to record |

### `vcs session commit <id>`

Archive the session and trigger memory extraction. Has a 60-second timeout due to LLM summarisation.

```bash
vcs session commit "$SESSION"
# Output: Session committed: viking://session/a1b2c3d4/
```

Returns: `{ status, session_uri, memory_extraction }` in JSON mode.

### `vcs session delete <id>`

Delete a session and all its entries. Returns deletion count.

```bash
vcs session delete "$SESSION"
# Output: Deleted session a1b2c3d4 (12 entries)
```

## Namespace Operations

Organize the `viking://` namespace by creating directories, removing nodes, and moving/renaming.

### `vcs mkdir <uri>`

Create a directory node. Auto-appends trailing `/` if missing.

```bash
vcs mkdir viking://resources/docs/
vcs mkdir viking://agent/skills    # trailing / added automatically
```

Returns 409 if directory already exists.

### `vcs rm <uri> --force`

Remove a node. **Agents MUST use `--force`** since they run non-interactively. Without `--force` in non-TTY mode, exits 1 with "Confirmation required (use --force in non-interactive mode)".

```bash
vcs rm viking://resources/docs/old-spec.md --force
vcs rm viking://resources/archive/ --force
```

| Flag | Required | Description |
|------|----------|-------------|
| `--force` | Yes (agents) | Skip confirmation prompt. Required in non-TTY mode. |

Returns 404 if not found. Returns 409 if node is currently processing.

### `vcs mv <from> <to>`

Move or rename a node.

```bash
vcs mv viking://resources/docs/draft.md viking://resources/docs/final.md
vcs mv viking://resources/old-dir/ viking://resources/new-dir/
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<from>` | Yes | Source URI |
| `<to>` | Yes | Destination URI |

Returns 404 if source not found. Returns 409 if source is currently processing.

## Health and Status

### `vcs health`

Quick connectivity check. Tests API reachability with a 5-second timeout.

```bash
vcs health
# Output: status  ok
#         latency_ms  42
#         endpoint  https://your-api.execute-api.us-east-1.amazonaws.com/prod/
```

Exit 0 if ok. Exit 2 if unreachable.

### `vcs status`

Instance overview with namespace summary. More detailed than health.

```bash
vcs status
# Output:
# endpoint  https://your-api.execute-api.us-east-1.amazonaws.com/prod/
#  latency  38ms
#
# Namespaces:
#   resources  12
#        user  3
#       agent  1
#     session  2
```

Shows item counts for each of the four scopes: resources, user, agent, session.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Client error (bad input, not found, already exists, confirmation required) |
| 2 | Server error or API unreachable |

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Confirmation required (use --force)" | `vcs rm` without `--force` in non-TTY | Always use `--force` for agent/script use |
| 404 on session message/commit | Session ID invalid or already committed | Create a new session with `vcs session create` |
| 409 on `vcs rm` or `vcs mv` | Resource currently processing (ingestion in progress) | Wait and retry; processing typically completes within 60s |
| 409 on `vcs mkdir` | Directory already exists | Safe to ignore — directory is present and usable |
| Session commit timeout | LLM memory extraction taking longer than 60s | Retry once; if persistent, check `vcs health` |
| Exit code 2 on `vcs health` | API unreachable | Check `VCS_API_URL`; verify network connectivity |
| Config init validation fails | Wrong URL or API key | Verify credentials; config saves anyway with a warning |

## Prerequisites

- VCS CLI installed and on PATH
- Configuration set via `vcs config init` or environment variables (`VCS_API_URL`, `VCS_API_KEY`)
- Network access to the VCS API endpoint
- For session commit: allow up to 60 seconds for LLM-based memory extraction
