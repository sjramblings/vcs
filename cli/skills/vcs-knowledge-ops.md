---
name: vcs-knowledge-ops
description: "Ingest URLs, PDFs, and HTML files with automatic content extraction"
compatibility: "VCS CLI configured via `vcs config init` or env vars VCS_API_URL + VCS_API_KEY"
---

# VCS Knowledge Ops

Ingest external content into the VCS knowledge base. This skill covers `vcs feed` for fetching and ingesting URLs, PDFs, and HTML files with automatic content extraction.

## When to Use

- Ingest a URL, PDF, or HTML file with automatic content extraction
- Convert web articles to markdown and store in VCS
- Ingest local PDF or HTML documents with text extraction

## Global Option

All VCS commands accept `--json` for machine-readable JSON output instead of human-readable text. Prefer `--json` when parsing output programmatically.

```bash
vcs feed https://example.com --json
```

## Command: `vcs feed`

Fetch and ingest content from URLs or local files with automatic content extraction. HTML pages are extracted via Mozilla Readability and converted to markdown. PDFs are extracted via unpdf. Markdown and plain text are ingested directly with source attribution.

### Basic Usage

```bash
vcs feed <source> [options]
```

### Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<source>` | Yes | -- | URL (http/https) or local file path |
| `--prefix <uri>` | No | `viking://resources/feed/` | URI prefix for stored content |
| `--filename <name>` | No | auto-derived from source | Override the stored filename |
| `--dry-run` | No | false | Preview extraction without ingesting |

### Supported Sources

**URLs (http/https):**
- HTML — article content extracted via Readability, converted to markdown
- PDF — text extracted via unpdf with page count
- Markdown / plain text — ingested directly with source attribution
- Other content types — rejected with error
- Fetch timeout: 30 seconds

**Local files:**
- `.pdf` — text extraction
- `.html`, `.htm` — Readability extraction
- `.md`, `.txt` — direct ingestion (title from YAML frontmatter or first heading)

### Content Size Limits

VCS uses Amazon Nova Lite for summarisation, which supports up to 300K input tokens (~945KB of text). Documents larger than this will fail with "Content too large". For very large PDFs, consider splitting into chapters before feeding.

### Output

Human-readable output shows extraction details:
```
  Title: Building Serverless APIs
 Source: https://example.com/blog/serverless-apis
  Words: 2,450
   File: serverless-apis.md
    URI: viking://resources/feed/serverless-apis.md
✓ Ingested viking://resources/feed/serverless-apis.md (2,450 words)
```

JSON output (`--json`):
```json
{
  "uri": "viking://resources/feed/serverless-apis.md",
  "title": "Building Serverless APIs",
  "words": 2450
}
```

Dry-run adds a preview field and skips ingestion.

### Examples

```bash
# Ingest a web article
vcs feed https://example.com/blog/serverless-apis

# Ingest a local PDF into a custom namespace
vcs feed ./reports/q1-review.pdf --prefix viking://resources/reports/

# Preview extraction without ingesting
vcs feed https://example.com/doc --dry-run

# Override the auto-derived filename
vcs feed ./notes.md --filename project-kickoff-notes.md --prefix viking://resources/notes/
```

### `feed` vs `ingest`

| | `vcs feed` | `vcs ingest` |
|---|-----------|-------------|
| **Input** | URLs, PDFs, HTML, markdown, text | Local files, directories, stdin |
| **Processing** | Extracts and converts to markdown | Stores content verbatim |
| **Best for** | External/rich content | Raw file storage, bulk directory ingestion |
| **Directory support** | No | Yes (`--recursive`) |
| **Stdin support** | No | Yes (`-` with `--filename`) |

**Rule of thumb:** Use `feed` for external content that needs extraction. Use `ingest` for local files you want stored as-is.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Client error (unsupported format, file not found, extraction failed) |
| 2 | Server error or API unreachable |

## Best Practices

### Namespace Organisation

Organise content into a shallow, well-structured hierarchy. VCS processes the namespace as a tree — every ingestion triggers parent directory rollup summaries up to the root. Deeper hierarchies mean more rollup cascades, more Bedrock calls, and more DynamoDB writes.

| Pattern | Recommendation |
|---------|---------------|
| Directory depth | Keep to 3-4 levels max (e.g., `viking://resources/project/area/doc.md`) |
| Items per directory | Aim for 10-30 items per directory. >50 items produces long rollup summaries that lose specificity |
| Flat dumps | Avoid ingesting 100+ files into a single directory — split into logical subdirectories |
| Deep nesting | Avoid paths like `a/b/c/d/e/f/doc.md` — each level triggers a separate rollup cascade |

### Recommended Namespace Layout

```
viking://resources/
├── docs/              # Project documentation (split by area)
│   ├── architecture/  # 5-15 docs per subdirectory
│   ├── api/
│   └── guides/
├── external/          # Ingested URLs and articles
│   ├── 2026-04/       # By month to avoid unbounded growth
│   └── 2026-03/
└── notes/             # Meeting notes, decisions
    ├── decisions/
    └── meetings/
```

### Bulk Ingestion Tips

- **Use `--recursive` for directories:** `vcs ingest ./docs/ --recursive` handles pacing. Avoid manual for-loops that fire many concurrent ingestions against the same parent directory.
- **Pre-create directories:** Use `vcs mkdir` to create the namespace structure before bulk ingest. This avoids auto-created directories with missing metadata.
- **Allow rollup time:** Large ingestions generate cascading rollup messages. Wait for the rollup queue to drain before searching for newly ingested content — rollup summaries make parent directories searchable.

## Troubleshooting

### Feed Errors

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Fetch failed: HTTP 403" | Site blocks automated requests | Download manually, then `vcs feed ./local-copy.html` |
| "Could not extract article content" | Readability failed on non-article page | Save page HTML, clean up, re-feed |
| "Unsupported content type" | URL serves JSON, XML, or other non-supported type | Download and convert to `.md` first |
| "PDF contains no extractable text" | Scanned/image-only PDF | OCR the PDF externally, then feed the text output |
| "Content too large" | Document exceeds 300K token limit (~945KB) | Split into smaller documents before feeding |
| Exit code 2 on ingest | Server-side error during processing | Run `vcs health`, retry after a moment |

## Cross-Skill Workflows

### Feed → Search → Read

```bash
# 1. Feed an external article into VCS
vcs feed https://example.com/architecture-patterns.html --prefix viking://resources/external/2026-04/

# 2. Search for it (after rollup completes, ~60s)
vcs find "architecture patterns"

# 3. Read the full content
vcs read viking://resources/external/2026-04/architecture-patterns.md --level 2
```

### Full Lifecycle: Onboard → Discover → Work → Learn

```bash
# ONBOARD: Ingest project documentation
vcs ingest ./docs/ --recursive --prefix viking://resources/myproject/

# DISCOVER: Find relevant context for a task
vcs find "authentication setup" --scope viking://resources/myproject/

# WORK: Load full content for selected resources
vcs read viking://resources/myproject/docs/auth.md --level 2

# LEARN: Track usage and extract memories
SESSION=$(vcs session create)
vcs session used "$SESSION" viking://resources/myproject/docs/auth.md
vcs session message "$SESSION" assistant "Auth uses JWT with 1h expiry..."
vcs session commit "$SESSION"
```

## Prerequisites

- VCS CLI installed and on PATH
- VCS configured via `vcs config init` or environment variables (`VCS_API_URL`, `VCS_API_KEY`)
- API reachable (verify with `vcs health`)
