---
name: vcs-add-data
description: "Ingest files/stdin and store memories in VCS"
compatibility: "VCS CLI configured via `vcs config init` or env vars VCS_API_URL + VCS_API_KEY"
---

# VCS Add Data

Ingest files and store memories in Viking Context Service. This skill covers two commands: `vcs ingest` for file/directory/stdin ingestion, and `vcs remember` for quick text memories.

## When to Use

- You have files (markdown, JSON, YAML, etc.) to store in VCS for later retrieval
- You want to pipe command output or generated content into VCS
- You need to record a quick memory or preference for future sessions
- You are onboarding a project's documentation into VCS

**Note:** For ingesting URLs or extracting content from PDFs/HTML with automatic conversion, use `vcs feed` in the `vcs-knowledge-ops` skill. Use `vcs ingest` for verbatim file/directory/stdin storage; use `vcs feed` for content extraction and conversion.

**Note:** See **Best Practices** in the `vcs-knowledge-ops` skill for namespace organisation guidelines — directory depth, items per directory, and bulk ingestion tips.

## Alternative: MCP Gateway Access

These tools are also available as MCP tools via the VCS AgentCore Gateway. MCP-native clients (Claude.ai, Claude Code, Cursor) connect directly to the Gateway URL with OAuth 2.1 — no CLI installation needed. See the project README for client configuration.

## Global Option

All VCS commands accept `--json` for machine-readable JSON output instead of human-readable text. Prefer `--json` when parsing output programmatically.

```bash
vcs ingest ./file.md --json
vcs remember "note" --json
```

## Command: `vcs ingest`

Ingest files into Viking Context Service. Supports three modes: single file, stdin, and recursive directory.

### Basic Usage

```bash
vcs ingest <path> [options]
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<path>` | Yes | -- | File path, directory path, or `-` for stdin |
| `--prefix <uri>` | No | `viking://resources/` | URI prefix for ingested content |
| `--filename <name>` | No | auto from file | Override filename (required for stdin) |
| `--recursive` | No | false | Ingest directory recursively |

### Supported File Extensions

`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.xml`, `.html`

Files with other extensions are skipped during recursive ingestion.

### Filename Normalization

Filenames are normalized before storage:
- Converted to lowercase
- Non-alphanumeric characters (except `.`, `-`, `_`) replaced with `-`
- Consecutive dashes collapsed
- Must start with `[a-z0-9]` (leading special characters stripped)

### Mode 1: Single File

Ingest a single file. The filename is derived from the file path unless `--filename` is provided.

```bash
# Ingest a markdown file into the docs namespace
vcs ingest ./docs/api-spec.md --prefix viking://resources/docs/

# Override the stored filename
vcs ingest ./README.md --prefix viking://resources/project/ --filename project-readme.md
```

### Mode 2: Stdin (Piped Input)

Ingest content piped from another command. `--filename` is **required** for stdin mode.

```bash
# Pipe text content
echo "Meeting notes: decided on REST over GraphQL" | vcs ingest - --filename meeting-2026-03-26.md --prefix viking://resources/notes/

# Pipe command output
git log --oneline -20 | vcs ingest - --filename recent-commits.txt --prefix viking://resources/project/

# Pipe generated content
curl -s https://api.example.com/spec | vcs ingest - --filename api-spec.json --prefix viking://resources/external/
```

Without `--filename`, stdin mode exits with an error:
```
Error: --filename is required when reading from stdin
```

### Mode 3: Recursive Directory

Ingest all supported files in a directory tree. `--recursive` is **required** for directory paths.

```bash
# Ingest all docs recursively
vcs ingest ./project-docs/ --recursive --prefix viking://resources/project/
```

Behavior:
- Skips dotfiles and directories starting with `.`
- Preserves subdirectory structure in the URI prefix (e.g., `subdir/file.md` becomes `viking://resources/project/subdir/file.md`)
- Only processes files with supported extensions
- Reports per-file success/failure with a final summary

Without `--recursive`, a directory path exits with an error:
```
Error: Use --recursive to ingest a directory
```

### Timeout

Ingest requests use a 60-second timeout (longer than the default 30s) to allow for server-side summarisation and embedding generation.

## Command: `vcs remember`

Store a quick text memory with an optional category. Memories are stored as resources under the user memory namespace and are searchable via `vcs find` and `vcs search`.

### Basic Usage

```bash
vcs remember <text> [--category <name>]
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<text>` | Yes | -- | Text to remember |
| `--category <name>` | No | `general` | Memory category |

### Storage Location

Memories are stored at:
```
viking://user/memories/{category}/{epoch-millis}-{random}
```

The identifier combines Unix epoch milliseconds with a 4-character random suffix (e.g., `1743026552341-a7x2`). This keeps chronological sortability while eliminating collision risk under concurrent writes.

### Examples

```bash
# Store a general memory
vcs remember "The API uses JWT tokens with 1-hour expiry"

# Store a categorized preference
vcs remember "User prefers TypeScript over JavaScript" --category preferences

# Store a project decision
vcs remember "Decided to use S3 Vectors over OpenSearch for cost reasons" --category decisions

# Store with JSON output for programmatic use
vcs remember "Deploy target is us-east-1" --category infrastructure --json
```

### JSON Output

With `--json`, remember returns the full API response:
```json
{
  "status": "created",
  "uri": "viking://user/memories/preferences/1743026552341-a7x2",
  "processing_status": "pending"
}
```

## Bulk Operations

### Directory Ingestion

```bash
# Ingest an entire documentation directory
vcs ingest ./docs/ --recursive --prefix viking://resources/project-docs/
```

### Scripted Batch Ingestion

```bash
# Ingest multiple specific files
for f in design.md architecture.md api-spec.md; do
  vcs ingest "./docs/$f" --prefix viking://resources/project/ --json
done

# Feed multiple URLs
urls=("https://example.com/page1" "https://example.com/page2")
for url in "${urls[@]}"; do
  vcs feed "$url" --prefix viking://resources/external/ --json
done
```

### Pipe-and-Ingest Pattern

```bash
# Capture command output as context
git diff HEAD~5..HEAD --stat | vcs ingest - --filename recent-changes.md --prefix viking://resources/project/

# Capture infrastructure state
kubectl get pods -o yaml | vcs ingest - --filename cluster-state.yaml --prefix viking://resources/infra/
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "--filename is required when reading from stdin" | Piping without `--filename` | Add `--filename name.md` |
| "Use --recursive to ingest a directory" | Directory path without flag | Add `--recursive` |
| File silently skipped in recursive mode | Unsupported extension | Only `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.xml`, `.html` are supported |
| Timeout during ingest | Large file or server-side processing | VCS uses 60s timeout; split large files or retry |
| Exit code 2 | Server error | Run `vcs health`; check API connectivity |

## Self-Ingestion

This skill file can be ingested into VCS for agent discovery:

```bash
vcs ingest cli/skills/vcs-add-data.md --prefix viking://agent/skills/
```

## Prerequisites

- VCS CLI installed and on PATH
- VCS configured via `vcs config init` or environment variables (`VCS_API_URL`, `VCS_API_KEY`)
- API reachable (verify with `vcs health`)
