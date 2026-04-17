# VCS Showcase Tests

Demo scripts for blog posts and video walkthroughs of Viking Context Service.

## Prerequisites

- **VCS deployed** with a reachable API endpoint
- **Environment variables** set:
  ```bash
  export VCS_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/v1"
  export VCS_API_KEY="your-api-key"
  ```
- **jq** installed (`brew install jq` on macOS)
- **base64** available (standard on macOS and Linux)
- **curl** available (standard on macOS and Linux)

## Scripts

| Script | What it demonstrates |
|--------|---------------------|
| `01-ingestion-pipeline.sh` | Ingest 3 markdown documents, read back at L0/L1/L2, show token reduction |
| `02-semantic-search.sh` | 5 searches with increasing specificity, ranked results, tokens saved |
| `03-namespace-browser.sh` | List/tree navigation, multi-level reads, mkdir/mv operations |
| `04-session-memory.sh` | Full session lifecycle: create, converse, track usage, commit, extract memories |
| `05-token-efficiency.sh` | Hero demo — 10 documents, flat RAG vs VCS token comparison |
| `06-parent-rollup.sh` | Hierarchical rollup: child docs roll up to parent and grandparent abstracts |

## Recommended Order

Run them in numbered order. Scripts 2 and 3 depend on Script 1 having populated `viking://resources/showcase/docs/`.

```bash
# Run all in sequence
./run-all.sh

# Or run individually
./01-ingestion-pipeline.sh
./02-semantic-search.sh
./03-namespace-browser.sh
./04-session-memory.sh
./05-token-efficiency.sh
./06-parent-rollup.sh
```

## What Each Test Demonstrates

### 01 — Ingestion Pipeline
Ingests 3 cloud security documents (~500 words each) into `viking://resources/showcase/docs/`. After each ingestion, reads the document back at all three levels (L0 abstract, L1 overview, L2 full content) and shows the token count at each. Ends with a summary showing total token reduction from L2 to L0.

### 02 — Semantic Search
Runs 5 searches against the documents from Script 01. Starts broad ("security") and gets increasingly specific ("principle of least privilege", "how does zero trust handle network perimeters"). Shows results ranked by relevance score and highlights the `tokens_saved_estimate` field.

### 03 — Namespace Browser
Explores the filesystem API: lists the root namespace, shows a recursive tree, reads one document at all 3 levels side-by-side, creates a directory, moves a document, and verifies the move. Demonstrates the agent scanning pattern: scan L0 first, decide relevance, load L2 only when needed.

### 04 — Session Memory
Creates a session and adds 5 messages simulating a conversation about deploying a Lambda function. Tracks URI usage, commits the session, and shows the extracted memories with their categories (preferences, entities, patterns). Reads the session back via the filesystem API.

### 05 — Token Efficiency (Hero Demo)
The core value proposition. Ingests 10 short documents, measures total L2 tokens across all of them, runs a search showing only L0 abstracts are returned, then compares: flat RAG (all documents in context) vs VCS initial scan (L0 only) vs VCS after drill-down (L0 + 2 relevant docs at L2). Visual comparison box at the end.

### 06 — Parent Rollup
Ingests 4 networking documents into `category-a/` and 3 compute documents into `category-b/`, both under `viking://resources/showcase/rollup-test/`. Waits for parent rollup at each level, then reads the parent and grandparent abstracts to show they synthesise their children. Demonstrates that an agent can scan one L0 abstract to understand an entire directory.

## Cleanup

`run-all.sh` prompts to clean up test data after all scripts finish. You can control this with the `VCS_SHOWCASE_CLEANUP` env var:

```bash
VCS_SHOWCASE_CLEANUP=auto ./run-all.sh   # clean up automatically
VCS_SHOWCASE_CLEANUP=skip ./run-all.sh   # skip cleanup prompt
./run-all.sh                              # prompted interactively (default)
```

To clean up manually:

```bash
curl -X DELETE "${VCS_API_URL}/fs/rm?uri=viking://resources/showcase/" \
  -H "x-api-key: ${VCS_API_KEY}" \
  -H "Content-Type: application/json"
```
